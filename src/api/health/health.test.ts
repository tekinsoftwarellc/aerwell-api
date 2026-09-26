import mongoose from "mongoose";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createServer } from "../../server.js";

describe("health endpoints", () => {
  it("reports the connected memory Mongo database", async () => {
    const response = await request(createServer()).get("/api/v1/health").expect(200);
    expect(response.body).toMatchObject({
      success: true,
      status: "success",
      statusCode: 200,
      data: { status: "ok", database: { status: "connected", name: mongoose.connection.name } },
    });
    expect(Number.isFinite(response.body.data.uptime)).toBe(true);
    expect(Number.isNaN(Date.parse(response.body.data.timestamp))).toBe(false);
    expect(response.headers["x-request-id"]).toBeTruthy();
  });
  it("serves liveness and readiness", async () => {
    expect(
      (await request(createServer()).get("/api/v1/health/live").expect(200)).body.data
    ).toEqual({ alive: true });
    expect(
      (await request(createServer()).get("/api/v1/health/ready").expect(200)).body.data
    ).toEqual({ ready: true });
  });
  it("fails readiness when Mongo disconnects", async () => {
    const uri = mongoose.connection.getClient().options.hosts[0]?.toString();
    const name = mongoose.connection.name;
    await mongoose.disconnect();
    try {
      expect(
        (await request(createServer()).get("/api/v1/health/ready").expect(503)).body
      ).toMatchObject({ success: false, code: "SERVICE_UNAVAILABLE", data: null });
      expect(
        (await request(createServer()).get("/api/v1/health").expect(200)).body.data.database.status
      ).toBe("disconnected");
    } finally {
      await mongoose.connect(`mongodb://${uri}/${name}`);
    }
  });
  it("returns a coded error for unknown routes", async () => {
    const response = await request(createServer()).get("/api/v1/unknown").expect(404);
    expect(response.body).toMatchObject({
      success: false,
      status: "error",
      code: "NOT_FOUND",
      data: null,
      statusCode: 404,
    });
  });
});
