import request from "supertest";
import { expect, it } from "vitest";
import { createServer } from "../../server.js";
import { staffFixture } from "../../test/staffFixture.js";
import { Location } from "../location/location.model.js";
import { seedRoles } from "../role/permission.js";
import { Role } from "../role/role.model.js";
import { OrganizationSettings } from "./settings.model.js";
const app = createServer();
it("reads and updates organization settings while rejecting foreign locations", async () => {
  const { accessToken } = await staffFixture();
  const location = await Location.create({ organizationId: "org-test", name: "Clinic" });
  const foreign = await Location.create({ organizationId: "foreign", name: "Other" });
  expect(
    (await request(app).get("/api/v1/settings/organization").auth(accessToken, { type: "bearer" }))
      .status
  ).toBe(200);
  const update = await request(app)
    .patch("/api/v1/settings/organization/profile")
    .auth(accessToken, { type: "bearer" })
    .send({
      name: "Aerwell Local",
      primaryLocationId: String(location._id),
      timeZone: "America/Los_Angeles",
    });
  expect(update.status).toBe(200);
  expect(update.body.data.name).toBe("Aerwell Local");
  expect(
    (
      await request(app)
        .patch("/api/v1/settings/organization/profile")
        .auth(accessToken, { type: "bearer" })
        .send({ primaryLocationId: String(foreign._id) })
    ).status
  ).toBe(404);
  expect(
    (
      await request(app)
        .patch("/api/v1/settings/organization/regional")
        .auth(accessToken, { type: "bearer" })
        .send({ dateFormat: "YYYY-MM-DD", measurementSystem: "metric", currency: "USD" })
    ).status
  ).toBe(200);
  expect(
    (
      await request(app)
        .patch("/api/v1/settings/security")
        .auth(accessToken, { type: "bearer" })
        .send({ autoSignOutMinutes: 15, requireTwoFactor: false })
    ).status
  ).toBe(200);
  expect(
    (await OrganizationSettings.findOne({ organizationId: "org-test" }))?.security
      ?.autoSignOutMinutes
  ).toBe(15);
  expect(
    (
      await request(app)
        .patch("/api/v1/settings/security")
        .auth(accessToken, { type: "bearer" })
        .send({ requireTwoFactor: true })
    ).status
  ).toBe(503);
});
it("enforces settings permissions and validates exactly nine unique role entries", async () => {
  const master = await staffFixture();
  const viewer = await staffFixture(false);
  expect(
    (
      await request(app)
        .get("/api/v1/settings/security")
        .auth(viewer.accessToken, { type: "bearer" })
    ).status
  ).toBe(403);
  const payload = { name: "New role", permissions: seedRoles[4]?.permissions };
  const created = await request(app)
    .post("/api/v1/roles")
    .auth(master.accessToken, { type: "bearer" })
    .send(payload);
  expect(created.status).toBe(201);
  expect(
    (
      await request(app)
        .patch(`/api/v1/roles/${created.body.data._id}`)
        .auth(master.accessToken, { type: "bearer" })
        .send({ name: "Renamed" })
    ).status
  ).toBe(200);
  expect(
    (
      await request(app)
        .post("/api/v1/roles")
        .auth(master.accessToken, { type: "bearer" })
        .send({ ...payload, permissions: [] })
    ).status
  ).toBe(400);
  expect(
    (
      await request(app)
        .get(`/api/v1/roles/${created.body.data._id}`)
        .auth(master.accessToken, { type: "bearer" })
    ).body.data.name
  ).toBe("Renamed");
  expect(
    (await request(app).get("/api/v1/roles").auth(master.accessToken, { type: "bearer" })).body.data
      .length
  ).toBe(3);
  const foreign = await Role.create({ ...payload, organizationId: "foreign" });
  expect(
    (
      await request(app)
        .get(`/api/v1/roles/${foreign._id}`)
        .auth(master.accessToken, { type: "bearer" })
    ).status
  ).toBe(404);
});
it("forces critical delivery preferences and filters audit events on both sides", async () => {
  const { accessToken } = await staffFixture();
  const pref = await request(app)
    .put("/api/v1/me/notification-preferences")
    .auth(accessToken, { type: "bearer" })
    .send({
      matrix: { critical_alerts: { in_app: false, push: false, email: false } },
      quietHours: { enabled: true, start: "21:00", end: "07:00" },
    });
  expect(pref.status).toBe(200);
  expect(pref.body.data.matrix.critical_alerts).toEqual({ in_app: true, push: true, email: true });
  expect(
    (
      await request(app)
        .get("/api/v1/me/notification-preferences")
        .auth(accessToken, { type: "bearer" })
    ).status
  ).toBe(200);
  const rule = await request(app)
    .post("/api/v1/notification-rules")
    .auth(accessToken, { type: "bearer" })
    .send({
      trigger: "failed_payment",
      recipient: { type: "role", id: (await Role.findOne())?._id },
      channels: ["in_app"],
      enabled: false,
    });
  expect(rule.status).toBe(201);
  expect(
    (
      await request(app)
        .patch(`/api/v1/notification-rules/${rule.body.data._id}`)
        .auth(accessToken, { type: "bearer" })
        .send({ enabled: true })
    ).status
  ).toBe(200);
  expect(
    (await request(app).get("/api/v1/notification-rules").auth(accessToken, { type: "bearer" }))
      .body.data
  ).toHaveLength(1);
  expect(
    (
      await request(app)
        .get("/api/v1/audit-events?action=updated")
        .auth(accessToken, { type: "bearer" })
    ).body.data.items.length
  ).toBeGreaterThan(0);
  expect(
    (
      await request(app)
        .get("/api/v1/audit-events?action=not_present")
        .auth(accessToken, { type: "bearer" })
    ).body.data.items
  ).toHaveLength(0);
});
