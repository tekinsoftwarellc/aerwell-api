import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { createServer } from "../../server.js";
import { StaffMember } from "../staff/staff.model.js";
import { StaffCredential } from "./auth.model.js";
import { hashPassword } from "./password.js";

vi.mock("../../common/services/email.service.js", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  emailConfigured: () => true,
}));

const password = "Local-test-passphrase!7";
const origin = env.CORS_ORIGIN.split(",")[0]?.trim() ?? "http://localhost:5173";
const MODE = { "x-token-mode": "cookie", origin, "sec-fetch-site": "same-site" };
const cookieOf = (res: request.Response) =>
  String(res.headers["set-cookie"]?.[0]).split(";")[0] as string;
let app: ReturnType<typeof createServer>;

beforeEach(async () => {
  app = createServer();
  const staff = await StaffMember.create({
    organizationId: "org-test",
    authAccountId: "independent",
    email: "staff@example.invalid",
    firstName: "Test",
    lastName: "Staff",
    accountStatus: "active",
    isSuperAdmin: true,
  });
  await StaffCredential.create({
    staffId: staff._id,
    organizationId: staff.organizationId,
    passwordHash: await hashPassword(password),
  });
});

const login = (headers: Record<string, string> = {}) =>
  request(app)
    .post("/api/v1/auth/login")
    .set(headers)
    .send({ email: "staff@example.invalid", password });

describe("staff cookie session (X-Token-Mode: cookie)", () => {
  it("login -> HttpOnly cookie only; refresh rotates it; logout clears it; replay is refused", async () => {
    const signedIn = await login(MODE);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.accessToken).toBeTruthy();
    expect(signedIn.body.data.refreshToken).toBeUndefined();
    expect(String(signedIn.headers["set-cookie"]?.[0])).toMatch(/HttpOnly; Secure; SameSite=Lax/);

    const refreshed = await request(app)
      .post("/api/v1/auth/refresh")
      .set(MODE)
      .set("Cookie", cookieOf(signedIn))
      .send({});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.refreshToken).toBeUndefined();
    expect(cookieOf(refreshed)).not.toBe(cookieOf(signedIn));

    const out = await request(app)
      .post("/api/v1/auth/logout")
      .set(MODE)
      .set("Cookie", cookieOf(refreshed))
      .send({});
    expect(out.status).toBe(200);
    expect(String(out.headers["set-cookie"]?.[0])).toContain("Max-Age=0");

    const replay = await request(app)
      .post("/api/v1/auth/refresh")
      .set(MODE)
      .set("Cookie", cookieOf(refreshed))
      .send({});
    expect(replay.status).toBe(401);
  });

  it("without the header the body contract is unchanged", async () => {
    const plain = await login();
    expect(plain.body.data.refreshToken).toBeTruthy();
    expect(plain.headers["set-cookie"]).toBeUndefined();
  });

  it("a cross-site caller stays on the body contract", async () => {
    const res = await login({ ...MODE, "sec-fetch-site": "cross-site" });
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
