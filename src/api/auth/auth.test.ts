import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { createServer } from "../../server.js";
import { AuditEvent } from "../audit/audit.js";
import { OrganizationSettings } from "../settings/settings.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { AuthChallenge, StaffCredential, StaffSession } from "./auth.model.js";
import { hashPassword } from "./password.js";
const mail = vi.hoisted(() => vi.fn());
vi.mock("../../common/services/email.service.js", () => ({
  sendEmail: mail,
  emailConfigured: () => true,
}));
const password = "Local-test-passphrase!7";
let app: ReturnType<typeof createServer>;
async function fixture() {
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
  return staff;
}
const login = () =>
  request(app).post("/api/v1/auth/login").send({ email: "staff@example.invalid", password });
beforeEach(() => {
  app = createServer();
  mail.mockReset();
  mail.mockResolvedValue(undefined);
});
describe("independent staff authentication", () => {
  it("issues Aerwell-only tokens, loads safe profile and audits login", async () => {
    const staff = await fixture();
    const response = await login();
    expect(response.status).toBe(200);
    const tokens = response.body.data;
    const claims = jwt.verify(tokens.accessToken, env.STAFF_JWT_SECRET ?? "", {
      audience: "aerwell-api",
      issuer: "aerwell-api",
      algorithms: ["HS256"],
    });
    expect(claims).toMatchObject({ sub: String(staff._id) });
    const me = await request(app).get("/api/v1/me").auth(tokens.accessToken, { type: "bearer" });
    expect(me.status).toBe(200);
    expect(me.body.data.visibleModules).toHaveLength(9);
    expect(JSON.stringify(me.body)).not.toContain("passwordHash");
    expect(await AuditEvent.countDocuments({ action: "signed_in" })).toBe(1);
    for (const path of ["/me/counters", "/permissions/modules"])
      expect(
        (await request(app).get(`/api/v1${path}`).auth(tokens.accessToken, { type: "bearer" }))
          .status
      ).toBe(200);
  });
  it("rejects unknown, wrong password, malformed input and locks repeated attempts", async () => {
    expect((await login()).body.code).toBe("INVALID_CREDENTIALS");
    await fixture();
    expect(
      (await request(app).post("/api/v1/auth/login").send({ email: "bad", password })).status
    ).toBe(400);
    for (let i = 0; i < 5; i++)
      expect(
        (
          await request(app)
            .post("/api/v1/auth/login")
            .send({ email: "staff@example.invalid", password: "incorrect" })
        ).status
      ).toBe(401);
    expect((await login()).status).toBe(423);
  });
  it("rejects inactive accounts and invalidates an active session after deactivation", async () => {
    const staff = await fixture();
    const response = await login();
    await StaffMember.updateOne({ _id: staff._id }, { $set: { accountStatus: "deactivated" } });
    expect((await login()).body.code).toBe("NOT_ALLOWED_ON_AERWELL");
    expect(
      (
        await request(app)
          .get("/api/v1/me")
          .auth(response.body.data.accessToken, { type: "bearer" })
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/v1/auth/refresh")
          .send({ refreshToken: response.body.data.refreshToken })
      ).status
    ).toBe(401);
  });
  it("rotates refresh tokens, revokes replayed families and logout invalidates access", async () => {
    await fixture();
    const first = (await login()).body.data;
    const next = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: first.refreshToken });
    expect(next.status).toBe(200);
    expect(next.body.data.refreshToken).not.toBe(first.refreshToken);
    expect(
      (await request(app).post("/api/v1/auth/refresh").send({ refreshToken: first.refreshToken }))
        .status
    ).toBe(401);
    expect(
      (await request(app).get("/api/v1/me").auth(next.body.data.accessToken, { type: "bearer" }))
        .status
    ).toBe(401);
    const fresh = (await login()).body.data;
    expect(
      (await request(app).post("/api/v1/auth/logout").send({ refreshToken: fresh.refreshToken }))
        .status
    ).toBe(200);
    expect(
      (await request(app).get("/api/v1/me").auth(fresh.accessToken, { type: "bearer" })).status
    ).toBe(401);
    expect(JSON.stringify(await StaffSession.find().lean())).not.toContain(fresh.refreshToken);
  });
  it("rejects wrong issuer/audience, expired and missing tokens", async () => {
    await fixture();
    const access = (await login()).body.data.accessToken;
    const claims = jwt.decode(access) as jwt.JwtPayload;
    for (const token of [
      "invalid",
      jwt.sign({ ...claims, aud: "other-api" }, env.STAFF_JWT_SECRET ?? ""),
      jwt.sign({ ...claims, iss: "alfred-auth" }, env.STAFF_JWT_SECRET ?? ""),
      jwt.sign({ ...claims, exp: 1 }, env.STAFF_JWT_SECRET ?? ""),
    ])
      expect((await request(app).get("/api/v1/me").auth(token, { type: "bearer" })).status).toBe(
        401
      );
    expect((await request(app).get("/api/v1/me")).status).toBe(401);
  });
  it("requires OTP, limits attempts and consumes each successful challenge once", async () => {
    await fixture();
    await OrganizationSettings.create({
      organizationId: "org-test",
      security: { requireTwoFactor: true },
    });
    const response = await login();
    expect(response.body.data.challenge).toBe("2FA_REQUIRED");
    expect(response.body.data.accessToken).toBeUndefined();
    const code = mail.mock.calls[0]?.[0].text.match(/\b\d{6}\b/)[0];
    const challengeId = response.body.data.challengeId;
    expect(JSON.stringify(await AuthChallenge.find().lean())).not.toContain(code);
    const verified = await request(app).post("/api/v1/auth/2fa/verify").send({ challengeId, code });
    expect(verified.status).toBe(200);
    expect(
      (await request(app).post("/api/v1/auth/2fa/verify").send({ challengeId, code })).status
    ).toBe(401);
    const second = (await login()).body.data;
    const secondCode = mail.mock.calls[1]?.[0].text.match(/\b\d{6}\b/)[0];
    for (let i = 0; i < 5; i++)
      expect(
        (
          await request(app)
            .post("/api/v1/auth/2fa/verify")
            .send({
              challengeId: second.challengeId,
              code: secondCode === "000000" ? "111111" : "000000",
            })
        ).status
      ).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/v1/auth/2fa/verify")
          .send({ challengeId: second.challengeId, code: secondCode })
      ).status
    ).toBe(401);
  });
  it("recovers credentials without account enumeration and burns existing sessions", async () => {
    await fixture();
    const first = (await login()).body.data;
    const known = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "staff@example.invalid" });
    const unknown = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "unknown@example.invalid" });
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    const token = mail.mock.calls[0]?.[0].text.split("#token=")[1];
    const reset = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token, password: "Replacement-passphrase!8" });
    expect(reset.status).toBe(200);
    expect(
      (await request(app).post("/api/v1/auth/reset-password").send({ token, password })).status
    ).toBe(401);
    expect(
      (await request(app).get("/api/v1/me").auth(first.accessToken, { type: "bearer" })).status
    ).toBe(401);
    expect((await login()).status).toBe(401);
  });
  it("rate limits the eleventh login attempt", async () => {
    for (let i = 0; i < 10; i++) await request(app).post("/api/v1/auth/login").send({});
    expect((await request(app).post("/api/v1/auth/login").send({})).status).toBe(429);
  });
});
it("changes passwords only with current credentials and signs out existing sessions", async () => {
  await fixture();
  const tokens = (await login()).body.data;
  const wrong = await request(app)
    .post("/api/v1/auth/change-password")
    .auth(tokens.accessToken, { type: "bearer" })
    .send({ currentPassword: "bad", password: "New-passphrase-for-staff!9" });
  expect(wrong.status).toBe(401);
  const changed = await request(app)
    .post("/api/v1/auth/change-password")
    .auth(tokens.accessToken, { type: "bearer" })
    .send({ currentPassword: password, password: "New-passphrase-for-staff!9" });
  expect(changed.status).toBe(200);
  expect(
    (await request(app).get("/api/v1/me").auth(tokens.accessToken, { type: "bearer" })).status
  ).toBe(401);
  expect(
    (
      await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "staff@example.invalid", password: "New-passphrase-for-staff!9" })
    ).status
  ).toBe(200);
});
it("rejects expired OTP challenges and fails closed when delivery fails", async () => {
  await fixture();
  await OrganizationSettings.create({
    organizationId: "org-test",
    security: { requireTwoFactor: true },
  });
  const challenge = (await login()).body.data;
  const code = mail.mock.calls[0]?.[0].text.match(/\b\d{6}\b/)[0];
  await AuthChallenge.updateOne(
    { _id: challenge.challengeId },
    { $set: { expiresAt: new Date(1) } }
  );
  expect(
    (
      await request(app)
        .post("/api/v1/auth/2fa/verify")
        .send({ challengeId: challenge.challengeId, code })
    ).status
  ).toBe(401);
  mail.mockRejectedValueOnce(new Error("Delivery failed"));
  expect((await login()).status).toBe(500);
  expect(await StaffSession.countDocuments()).toBe(0);
});
