import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "../errors/AppError.js";
import { errorHandler } from "./errorHandler.js";
import { validate } from "./validate.js";

const throwingApp = (error: Error) => {
  const app = express();
  app.get("/", () => {
    throw error;
  });
  app.use(errorHandler);
  return app;
};
describe("error envelope", () => {
  it("preserves an explicit application code", async () => {
    const response = await request(
      throwingApp(new AppError("Denied", 403, true, null, "NOT_ALLOWED_ON_AERWELL"))
    )
      .get("/")
      .expect(403);
    expect(response.body).toEqual({
      success: false,
      status: "error",
      code: "NOT_ALLOWED_ON_AERWELL",
      message: "Denied",
      data: null,
      statusCode: 403,
    });
  });
  it("formats Zod issues as path/message entries", async () => {
    const parsed = z.object({ email: z.string().email() }).safeParse({ email: "invalid" });
    if (parsed.success) throw new Error("Expected invalid fixture");
    const response = await request(throwingApp(parsed.error)).get("/").expect(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(response.body.data).toEqual([{ path: "email", message: "Invalid email" }]);
  });
  it("uses the same validation envelope through route middleware", async () => {
    const app = express();
    app.use(express.json());
    app.post(
      "/",
      validate({ body: z.object({ email: z.string().email() }).strict() }),
      (_req, res) => {
        res.sendStatus(204);
      }
    );
    app.use(errorHandler);
    const response = await request(app).post("/").send({ email: "invalid" }).expect(400);
    expect(response.body).toMatchObject({
      code: "VALIDATION_ERROR",
      data: [{ path: "body.email", message: "Invalid email" }],
    });
    await request(app).post("/").send({ email: "test@example.com", unexpected: true }).expect(400);
    await request(app).post("/").send({ email: "test@example.com" }).expect(204);
  });
  it("assigns a default code to unhandled errors", async () => {
    const response = await request(throwingApp(new Error("Unexpected failure")))
      .get("/")
      .expect(500);
    expect(response.body).toMatchObject({
      success: false,
      code: "INTERNAL_ERROR",
      statusCode: 500,
    });
  });
});
