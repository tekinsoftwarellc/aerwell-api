import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { tokenCookieMode } from "./tokenCookieMode.js";

const ORIGIN = "https://admin.example.dev";
const app = (allowed: (o: string) => boolean = (o) => o === ORIGIN) => {
  const a = express();
  a.use(express.json());
  a.use(
    "/api/v1/auth",
    tokenCookieMode({
      isAllowedOrigin: allowed,
      maxAgeSeconds: 100,
      cookiePath: "/api/v1/auth",
    })
  );
  a.post("/api/v1/auth/login", (_req, res) =>
    res.json({
      success: true,
      data: { accessToken: "a1", refreshToken: "r1" },
    })
  );
  a.post("/api/v1/auth/nested", (_req, res) =>
    res.json({
      success: true,
      data: { tokens: { accessToken: "a1", refreshToken: "r1" } },
    })
  );
  a.post("/api/v1/auth/fail", (_req, res) =>
    res.status(401).json({ success: false, data: { refreshToken: "x" } })
  );
  a.post("/api/v1/auth/refresh", (req, res) =>
    req.body?.refreshToken === "r1"
      ? res.json({
          success: true,
          data: { accessToken: "a2", refreshToken: "r2" },
        })
      : res.status(401).json({ success: false, body: req.body })
  );
  a.post("/api/v1/auth/logout", (req, res) => res.json({ success: true, body: req.body }));
  return a;
};
const cookieMode = {
  "x-token-mode": "cookie",
  origin: ORIGIN,
  "sec-fetch-site": "same-site",
};

describe("tokenCookieMode", () => {
  it("leaves requests without the header untouched (mobile / scripts)", async () => {
    const res = await request(app()).post("/api/v1/auth/login").send({});
    expect(res.body.data.refreshToken).toBe("r1");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("moves the refresh token from the body into an HttpOnly Secure cookie", async () => {
    const res = await request(app()).post("/api/v1/auth/login").set(cookieMode).send({});
    expect(res.body.data).toEqual({ accessToken: "a1" });
    const cookie = String(res.headers["set-cookie"]?.[0]);
    expect(cookie).toContain("__Secure-admin_rt=r1");
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toContain("Path=/api/v1/auth");
    expect(cookie).toContain("Max-Age=100");
  });

  it("handles the data.tokens body shape", async () => {
    const res = await request(app()).post("/api/v1/auth/nested").set(cookieMode).send({});
    expect(res.body.data.tokens).toEqual({ accessToken: "a1" });
    expect(String(res.headers["set-cookie"]?.[0])).toContain("__Secure-admin_rt=r1");
  });

  it("never sets a cookie on a failed response", async () => {
    const res = await request(app()).post("/api/v1/auth/fail").set(cookieMode).send({});
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("injects the cookie as refreshToken on refresh, and the rotation lands in a new cookie", async () => {
    const res = await request(app())
      .post("/api/v1/auth/refresh")
      .set(cookieMode)
      .set("Cookie", "other=1; __Secure-admin_rt=r1")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accessToken: "a2" });
    expect(String(res.headers["set-cookie"]?.[0])).toContain("__Secure-admin_rt=r2");
  });

  it("without the cookie the refresh falls through unchanged (no body token)", async () => {
    const res = await request(app()).post("/api/v1/auth/refresh").set(cookieMode).send({});
    expect(res.status).toBe(401);
    expect(res.body.body).toEqual({});
  });

  it("a body refreshToken wins over the cookie (legacy migration)", async () => {
    const res = await request(app())
      .post("/api/v1/auth/refresh")
      .set(cookieMode)
      .set("Cookie", "__Secure-admin_rt=zzz")
      .send({ refreshToken: "r1" });
    expect(res.status).toBe(200);
  });

  it("does not inject the cookie into login", async () => {
    const res = await request(app())
      .post("/api/v1/auth/login")
      .set(cookieMode)
      .set("Cookie", "__Secure-admin_rt=r1")
      .send({});
    expect(res.status).toBe(200);
  });

  it("logout clears the cookie", async () => {
    const res = await request(app())
      .post("/api/v1/auth/logout")
      .set(cookieMode)
      .set("Cookie", "__Secure-admin_rt=r1")
      .send({});
    expect(res.body.body.refreshToken).toBe("r1");
    expect(String(res.headers["set-cookie"]?.[0])).toMatch(/__Secure-admin_rt=;.*Max-Age=0/);
  });

  it("cross-site callers stay on body mode (no cookie, token stays in the body)", async () => {
    const res = await request(app())
      .post("/api/v1/auth/login")
      .set({ ...cookieMode, "sec-fetch-site": "cross-site" })
      .send({});
    expect(res.body.data.refreshToken).toBe("r1");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("a missing Sec-Fetch-Site (non-browser) stays on body mode", async () => {
    const { "sec-fetch-site": Drop, ...headers } = cookieMode;
    const res = await request(app()).post("/api/v1/auth/login").set(headers).send({});
    expect(res.body.data.refreshToken).toBe("r1");
  });

  it("refuses cookie mode from an origin that is not on the allowlist", async () => {
    const res = await request(app())
      .post("/api/v1/auth/login")
      .set({ ...cookieMode, origin: "https://evil.example" })
      .send({});
    expect(res.status).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses cookie mode without an Origin header", async () => {
    const { origin: O, ...headers } = cookieMode;
    const res = await request(app()).post("/api/v1/auth/login").set(headers).send({});
    expect(res.status).toBe(403);
  });
});

describe("tokenCookieMode allowlist errors", () => {
  it("treats a throwing or rejecting allowlist check as a refusal, never a hang", async () => {
    for (const check of [
      () => {
        throw new Error("boom");
      },
      () => Promise.reject(new Error("boom")),
    ]) {
      const res = await request(app(check as (o: string) => boolean))
        .post("/api/v1/auth/login")
        .set(cookieMode)
        .send({});
      expect(res.status).toBe(403);
    }
  });
});
