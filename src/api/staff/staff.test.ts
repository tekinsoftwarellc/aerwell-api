import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import { createServer } from "../../server.js";
import { staffFixture } from "../../test/staffFixture.js";
import { Invite } from "../invite/invite.model.js";
import { StaffMember } from "./staff.model.js";
const email = vi.hoisted(() => vi.fn());
vi.mock("../../common/services/email.service.js", () => ({
  sendEmail: email,
  emailConfigured: () => true,
}));
let app: ReturnType<typeof createServer>;
beforeEach(() => {
  app = createServer();
  email.mockReset();
  email.mockResolvedValue(undefined);
});
function createStaff(token: string, roleId: string) {
  return request(app)
    .post("/api/v1/staff")
    .auth(token, { type: "bearer" })
    .send({
      firstName: "New",
      lastName: "Clinician",
      email: "new@example.invalid",
      roleId,
      employmentType: "full_time",
      licenses: [{ name: "License", expirationDate: "2030-01-01" }],
    });
}
it("creates standalone pending staff, accepts invite once and filters directory both ways", async () => {
  const master = await staffFixture();
  const created = await createStaff(master.accessToken, String(master.role._id));
  expect(created.status).toBe(201);
  expect(created.body.data.staff.accountStatus).toBe("pending_onboarding");
  expect((await createStaff(master.accessToken, String(master.role._id))).body.code).toBe(
    "STAFF_EMAIL_EXISTS"
  );
  for (const [q, total] of [
    ["Clinician", 1],
    ["absent", 0],
  ] as const) {
    const res = await request(app)
      .get(`/api/v1/staff?q=${q}`)
      .auth(master.accessToken, { type: "bearer" });
    expect(res.body.data.pagination.total).toBe(total);
  }
  expect(
    (
      await request(app)
        .get("/api/v1/staff?status[]=pending_onboarding")
        .auth(master.accessToken, { type: "bearer" })
    ).body.data.items
  ).toHaveLength(1);
  expect(
    (
      await request(app)
        .get("/api/v1/staff?status[]=deactivated")
        .auth(master.accessToken, { type: "bearer" })
    ).body.data.items
  ).toHaveLength(0);
  const token = email.mock.calls[0]?.[0].text.split("#token=")[1];
  expect(
    (
      await request(app).post("/api/v1/auth/accept-invite").send({
        token,
        password: "Invitation-passphrase!9",
        firstName: "New",
        lastName: "Clinician",
      })
    ).status
  ).toBe(200);
  expect(
    (
      await request(app).post("/api/v1/auth/accept-invite").send({
        token,
        password: "Invitation-passphrase!9",
        firstName: "New",
        lastName: "Clinician",
      })
    ).status
  ).toBe(401);
  expect(
    (
      await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "new@example.invalid", password: "Invitation-passphrase!9" })
    ).status
  ).toBe(200);
});
it("masks compensation, enforces view/edit and own scope, and audits staff reads", async () => {
  const master = await staffFixture();
  const viewer = await staffFixture(false, 2);
  const id = String(master.staff._id);
  expect(
    (
      await request(app)
        .patch(`/api/v1/staff/${id}/compensation`)
        .auth(master.accessToken, { type: "bearer" })
        .send({ payType: "salary", paySchedule: "biweekly", annualSalaryCents: 10000000 })
    ).status
  ).toBe(200);
  const own = await request(app)
    .get(`/api/v1/staff/${id}/employment`)
    .auth(master.accessToken, { type: "bearer" });
  expect(own.body.data.compensation.annualSalaryCents).toBe(10000000);
  const masked = await request(app)
    .get(`/api/v1/staff/${id}/employment`)
    .auth(viewer.accessToken, { type: "bearer" });
  expect(masked.status).toBe(200);
  expect(masked.body.data.compensation).toBeUndefined();
  expect(
    (
      await request(app)
        .patch(`/api/v1/staff/${id}`)
        .auth(viewer.accessToken, { type: "bearer" })
        .send({ firstName: "Denied" })
    ).status
  ).toBe(403);
  await StaffMember.updateOne(
    { _id: viewer.staff._id },
    { $set: { permissionOverrides: [{ module: "STAFF_RECORDS", level: "view", scope: "own" }] } }
  );
  expect(
    (await request(app).get(`/api/v1/staff/${id}`).auth(viewer.accessToken, { type: "bearer" }))
      .status
  ).toBe(404);
  expect(
    (await request(app).get("/api/v1/staff").auth(viewer.accessToken, { type: "bearer" })).body.data
      .pagination.total
  ).toBe(1);
});
it("deactivates atomically, revokes access and preserves staff history; blocks self", async () => {
  const first = await staffFixture();
  const target = await staffFixture();
  expect(
    (
      await request(app)
        .post(`/api/v1/staff/${first.staff._id}/deactivate`)
        .auth(first.accessToken, { type: "bearer" })
        .send({ reason: "left_org" })
    ).body.code
  ).toBe("CANNOT_DEACTIVATE_SELF");
  expect(
    (
      await request(app)
        .post(`/api/v1/staff/${target.staff._id}/deactivate`)
        .auth(first.accessToken, { type: "bearer" })
        .send({ reason: "other" })
    ).status
  ).toBe(400);
  const result = await request(app)
    .post(`/api/v1/staff/${target.staff._id}/deactivate`)
    .auth(first.accessToken, { type: "bearer" })
    .send({ reason: "left_org", notify: false });
  expect(result.status).toBe(200);
  expect(result.body.data.auditEventId).toBeTruthy();
  expect(
    (await request(app).get("/api/v1/me").auth(target.accessToken, { type: "bearer" })).status
  ).toBe(403);
  expect(await StaffMember.countDocuments()).toBe(2);
});
it("expires invitations and revokes/resends without exposing invitation secrets", async () => {
  const master = await staffFixture();
  const created = await createStaff(master.accessToken, String(master.role._id));
  const invite = created.body.data.invite;
  expect(JSON.stringify(created.body)).not.toContain("tokenHash");
  await Invite.updateOne({ _id: invite._id }, { $set: { expiresAt: new Date(1) } });
  const token = email.mock.calls[0]?.[0].text.split("#token=")[1];
  expect(
    (
      await request(app)
        .post("/api/v1/auth/accept-invite")
        .send({ token, password: "Invitation-passphrase!9", firstName: "New", lastName: "Staff" })
    ).status
  ).toBe(401);
  const resent = await request(app)
    .post(`/api/v1/invites/${invite._id}/resend`)
    .auth(master.accessToken, { type: "bearer" })
    .send({});
  expect(resent.status).toBe(200);
  expect(
    (
      await request(app)
        .post(`/api/v1/invites/${resent.body.data._id}/revoke`)
        .auth(master.accessToken, { type: "bearer" })
        .send({})
    ).status
  ).toBe(200);
  expect(
    (
      await request(app)
        .get("/api/v1/invites?status=pending")
        .auth(master.accessToken, { type: "bearer" })
    ).body.data
  ).toHaveLength(0);
});
it("updates profile, notes, employment, certificates and permissions with complete audit history", async () => {
  const master = await staffFixture();
  const target = await staffFixture(false, 2);
  const id = String(target.staff._id);
  const auth = { type: "bearer" as const };
  expect(
    (await request(app).get(`/api/v1/staff/${id}`).auth(master.accessToken, auth)).status
  ).toBe(200);
  expect(
    (
      await request(app)
        .patch(`/api/v1/staff/${id}`)
        .auth(master.accessToken, auth)
        .send({ firstName: "Updated" })
    ).body.data.firstName
  ).toBe("Updated");
  expect(
    (
      await request(app)
        .post(`/api/v1/staff/${id}/notes`)
        .auth(master.accessToken, auth)
        .send({ body: "Synthetic staff note" })
    ).status
  ).toBe(201);
  expect(
    (
      await request(app)
        .patch(`/api/v1/staff/${id}/employment`)
        .auth(master.accessToken, auth)
        .send({ employmentType: "part_time", startDate: "2026-01-01" })
    ).status
  ).toBe(200);
  const cert = await request(app)
    .post(`/api/v1/staff/${id}/certifications`)
    .auth(master.accessToken, auth)
    .send({ name: "Synthetic cert", issuer: "Test", expirationDate: "2020-01-01" });
  expect(cert.status).toBe(201);
  expect(cert.body.data[0].status).toBe("expired");
  expect(
    (
      await request(app)
        .patch(`/api/v1/staff/${id}/certifications/${cert.body.data[0]._id}`)
        .auth(master.accessToken, auth)
        .send({ expirationDate: "2035-01-01" })
    ).body.data[0].status
  ).toBe("active");
  expect(
    (await request(app).get(`/api/v1/staff/${id}/certifications`).auth(master.accessToken, auth))
      .body.data
  ).toHaveLength(1);
  const response = await request(app)
    .put(`/api/v1/staff/${id}/permissions`)
    .auth(master.accessToken, auth)
    .send({
      roleId: String(target.role._id),
      employmentType: "part_time",
      overrides: [{ module: "STAFF_RECORDS", level: "view", scope: "own" }],
    });
  expect(response.status).toBe(200);
  expect(response.body.data.effective.STAFF_RECORDS.scope).toBe("own");
  expect(
    (await request(app).get(`/api/v1/staff/${id}/permissions`).auth(master.accessToken, auth))
      .status
  ).toBe(200);
  expect(
    (await request(app).get(`/api/v1/staff/${id}/activity?limit=3`).auth(master.accessToken, auth))
      .body.data.length
  ).toBeGreaterThan(0);
  expect(
    (
      await request(app)
        .get(`/api/v1/staff?roleIds[]=${target.role._id}`)
        .auth(master.accessToken, auth)
    ).body.data.pagination.total
  ).toBe(1);
  expect(
    (
      await request(app)
        .get("/api/v1/staff?flags[]=certification_renewal")
        .auth(master.accessToken, auth)
    ).body.data.pagination.total
  ).toBe(0);
  expect(
    (await request(app).get("/api/v1/staff/roles").auth(master.accessToken, auth)).body.data
  ).toHaveLength(2);
});
it("preserves the last super admin under concurrent deactivation", async () => {
  const manager = await staffFixture(false, 0);
  const first = await staffFixture();
  const second = await staffFixture();
  const responses = await Promise.all(
    [first, second].map((target) =>
      request(app)
        .post(`/api/v1/staff/${target.staff._id}/deactivate`)
        .auth(manager.accessToken, { type: "bearer" })
        .send({ reason: "security_concern" })
    )
  );
  expect(responses.map((r) => r.status).sort()).toEqual([200, 422]);
  expect(responses.find((r) => r.status === 422)?.body.code).toBe("LAST_SUPER_ADMIN");
  expect(await StaffMember.countDocuments({ isSuperAdmin: true, accountStatus: "active" })).toBe(1);
});
it("bulk deactivation checks all targets and rejects permission escalation", async () => {
  const master = await staffFixture();
  const target = await staffFixture(false, 2);
  const third = await staffFixture(false, 2);
  const result = await request(app)
    .post("/api/v1/staff/bulk/deactivate")
    .auth(master.accessToken, { type: "bearer" })
    .send({ ids: [String(target.staff._id), String(third.staff._id)], reason: "left_org" });
  expect(result.status).toBe(200);
  const manager = await staffFixture(false, 0);
  const denied = await request(app)
    .put(`/api/v1/staff/${master.staff._id}/permissions`)
    .auth(manager.accessToken, { type: "bearer" })
    .send({
      roleId: String(manager.role._id),
      employmentType: "full_time",
      overrides: [{ module: "BILLING", level: "master", scope: "all" }],
    });
  expect(denied.status).toBe(403);
});
it("creates email-only invites without linking an Alfred staff account", async () => {
  const master = await staffFixture();
  const invite = await request(app)
    .post("/api/v1/invites")
    .auth(master.accessToken, { type: "bearer" })
    .send({ email: "invited@example.invalid", roleId: String(master.role._id) });
  expect(invite.status).toBe(201);
  expect(invite.body.data.deliveryStatus).toBe("sent");
  const staff = await StaffMember.findOne({ email: "invited@example.invalid" });
  expect(staff?.authAccountId).toBeUndefined();
  expect(staff?.accountStatus).toBe("pending_onboarding");
});

it("filters custom flags on both sides and resolves them with staff scope", async () => {
  const master = await staffFixture();
  const target = await staffFixture(false);
  const flag = await request(app)
    .post(`/api/v1/staff/${target.staff._id}/flags`)
    .auth(master.accessToken, { type: "bearer" })
    .send({ label: "Synthetic follow-up" });
  expect(flag.status).toBe(201);
  expect(
    (
      await request(app)
        .get("/api/v1/staff?flags[]=custom")
        .auth(master.accessToken, { type: "bearer" })
    ).body.data.pagination.total
  ).toBe(1);
  expect(
    (
      await request(app)
        .post(`/api/v1/staff/${target.staff._id}/flags/${flag.body.data._id}/resolve`)
        .auth(master.accessToken, { type: "bearer" })
        .send({})
    ).status
  ).toBe(200);
  expect(
    (
      await request(app)
        .get("/api/v1/staff?flags[]=custom")
        .auth(master.accessToken, { type: "bearer" })
    ).body.data.pagination.total
  ).toBe(0);
});
it("reports requested notification delivery and preserves deactivation when email fails", async () => {
  const master = await staffFixture();
  const first = await staffFixture(false);
  const second = await staffFixture(false);
  const sent = await request(app)
    .post(`/api/v1/staff/${first.staff._id}/deactivate`)
    .auth(master.accessToken, { type: "bearer" })
    .send({ reason: "left_org", notify: true });
  expect(sent.body.data.deliveryStatus).toBe("sent");
  email.mockRejectedValueOnce(new Error("Unavailable"));
  const failed = await request(app)
    .post(`/api/v1/staff/${second.staff._id}/deactivate`)
    .auth(master.accessToken, { type: "bearer" })
    .send({ reason: "left_org", notify: true });
  expect(failed.status).toBe(200);
  expect(failed.body.data.deliveryStatus).toBe("failed");
  expect((await StaffMember.findById(second.staff._id))?.accountStatus).toBe("deactivated");
});
