import { Writable } from "node:stream";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createLogger } from "../utils/logger.js";
import { createRequestLogger } from "./requestLogger.js";

describe("logging privacy", () => {
  it("removes PHI and credentials from structured logs and HTTP URL queries", async () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, done) {
        output += chunk.toString();
        done();
      },
    });
    const log = createLogger(stream);
    const secrets = {
      email: "phi-seed@example.test",
      firstName: "SensitiveFirst",
      lastName: "SensitiveLast",
      phone: "555-0199-sensitive",
      dateOfBirth: "1901-02-03",
      notes: "Sensitive clinical note",
      labValue: "Sensitive laboratory value",
      password: "fixture-password-123",
      accessToken: "fixture-access-token",
      refreshToken: "fixture-refresh-token",
      authorization: "Bearer fixture-authorization",
      // biome-ignore lint/style/useNamingConvention: OAuth credential field must be exercised verbatim.
      client_secret: "fixture-client-secret",
    };
    log.info(
      {
        ...secrets,
        profile: { ...secrets },
        data: { laboratory: { ...secrets } },
        req: {
          body: { ...secrets },
          headers: { authorization: secrets.authorization, cookie: "fixture-cookie" },
        },
      },
      "Structured event"
    );
    const app = express();
    app.use(createRequestLogger(log, true));
    app.get("/members", (_req, res) => {
      res.json({ ok: true });
    });
    app.use((_req, res) => {
      res.sendStatus(404);
    });
    await request(app)
      .get(`/members?q=${secrets.email}&note=SensitiveQueryNote`)
      .set("Authorization", secrets.authorization)
      .set("User-Agent", "SensitiveUserAgent")
      .expect(200);
    await request(app).get("/SensitiveUnknownPath").expect(404);
    expect(output).toContain("Structured event");
    expect(output).toContain('"statusCode":200');
    expect(output).toContain('"method":"GET"');
    for (const value of [
      ...Object.values(secrets),
      "fixture-cookie",
      "SensitiveQueryNote",
      "SensitiveUserAgent",
      "SensitiveUnknownPath",
    ]) {
      expect(output).not.toContain(value);
    }
  });
});
