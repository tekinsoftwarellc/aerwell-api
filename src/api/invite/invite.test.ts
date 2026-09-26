import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import { createServer } from "../../server.js";
import { staffFixture } from "../../test/staffFixture.js";
import { MODULES } from "../role/permission.js";
import { Role } from "../role/role.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { Invite } from "./invite.model.js";

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
const allMaster = () =>
  Role.create({
    organizationId: "org-test",
    name: `All master ${Math.random()}`,
    permissions: MODULES.map((module) => ({ module, level: "master", scope: "all" })),
  });
const invite = (token: string, body: object) =>
  request(app).post("/api/v1/invites").auth(token, { type: "bearer" }).send(body);
const tokenFrom = () => String(email.mock.calls.at(-1)?.[0]?.text).split("#token=")[1] ?? "";

it("W11: re-inviting a pending person with another role applies that role to the invite and the account", async () => {
  const admin = await staffFixture();
  const nurse = await Role.findOne({ _id: (await staffFixture(false, 2)).role._id });
  const coordinator = await Role.findOne({ _id: (await staffFixture(false, 3)).role._id });
  const first = await invite(admin.accessToken, {
    email: "pending@example.invalid",
    roleId: String(nurse?._id),
  });
  expect(first.status).toBe(201);
  const again = await invite(admin.accessToken, {
    email: "pending@example.invalid",
    roleId: String(coordinator?._id),
  });
  expect(again.status).toBe(201);
  expect(String(again.body.data.roleId)).toBe(String(coordinator?._id));
  const pending = await StaffMember.findOne({ email: "pending@example.invalid" });
  expect(String(pending?.roleId)).toBe(String(coordinator?._id));
  expect(await Invite.countDocuments({ staffId: pending?._id, status: "pending" })).toBe(1);
  const accepted = await request(app).post("/api/v1/auth/accept-invite").send({
    token: tokenFrom(),
    password: "Accept-test-passphrase!9",
    firstName: "Pat",
    lastName: "Pending",
  });
  expect(accepted.status).toBe(200);
  const active = await StaffMember.findOne({ email: "pending@example.invalid" });
  expect(active?.accountStatus).toBe("active");
  expect(String(active?.roleId)).toBe(String(coordinator?._id));
});

it("W11: resending an invite re-checks that the sender may grant the pending person's role", async () => {
  const admin = await staffFixture();
  const powerful = await allMaster();
  const created = await invite(admin.accessToken, {
    email: "powerful@example.invalid",
    roleId: String(powerful._id),
  });
  expect(created.status).toBe(201);
  // The medical director has STAFF_RECORDS master but only BILLING view.
  const director = await staffFixture(false, 0);
  const resend = await request(app)
    .post(`/api/v1/invites/${created.body.data._id}/resend`)
    .auth(director.accessToken, { type: "bearer" });
  expect(resend.status).toBe(403);
  expect(await Invite.countDocuments({ status: "pending" })).toBe(1);
  expect(email).toHaveBeenCalledTimes(1);
  // …and cannot re-invite the same person to keep that role either.
  const reinvite = await invite(director.accessToken, {
    email: "powerful@example.invalid",
    roleId: String(director.role._id),
  });
  expect(reinvite.status).toBe(201);
  const pending = await StaffMember.findOne({ email: "powerful@example.invalid" });
  expect(String(pending?.roleId)).toBe(String(director.role._id));
  // The super admin may still resend.
  const own = await Invite.findOne({ status: "pending" });
  const superResend = await request(app)
    .post(`/api/v1/invites/${own?._id}/resend`)
    .auth(admin.accessToken, { type: "bearer" });
  expect(superResend.status).toBe(200);
});

it("W11 review: re-inviting a pending person with a grantable role still checks their overrides", async () => {
  const admin = await staffFixture();
  const director = await staffFixture(false, 0);
  const created = await invite(admin.accessToken, {
    email: "overrides@example.invalid",
    roleId: String(director.role._id),
  });
  expect(created.status).toBe(201);
  await StaffMember.updateOne(
    { email: "overrides@example.invalid" },
    { permissionOverrides: [{ module: "BILLING", level: "master", scope: "all" }] }
  );
  await request(app)
    .post(`/api/v1/invites/${created.body.data._id}/revoke`)
    .auth(admin.accessToken, { type: "bearer" });
  const again = await invite(director.accessToken, {
    email: "overrides@example.invalid",
    roleId: String(director.role._id),
  });
  expect(again.status).toBe(403);
  expect(await Invite.countDocuments({ status: "pending" })).toBe(0);
});
