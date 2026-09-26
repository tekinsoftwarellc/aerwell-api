import { Types } from "mongoose";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import { createServer } from "../../server.js";
import { AuditEvent } from "../audit/audit.js";
import { StaffCredential } from "../auth/auth.model.js";
import { hashPassword } from "../auth/password.js";
import { Market } from "../catalog/catalog.model.js";
import { Environment, Location } from "../location/location.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { Service, ServiceCategory } from "./service.model.js";
import { seedCatalog, seedCategories } from "./service.seed.js";
const imageMocks = vi.hoisted(() => ({ presign: vi.fn(), attach: vi.fn(), url: vi.fn() }));
vi.mock("./serviceImage.service.js", () => ({
  presignServiceImage: imageMocks.presign,
  attachServiceImage: imageMocks.attach,
  serviceImageUrl: imageMocks.url,
}));
let app: ReturnType<typeof createServer>;
let token: string;
let actor: InstanceType<typeof StaffMember>;
let base: Record<string, unknown>;
let categoryId: string;
let marketId: string;
const auth = () => ({ authorization: `Bearer ${token}` });
beforeEach(async () => {
  imageMocks.url.mockResolvedValue(undefined);
  imageMocks.attach.mockResolvedValue(undefined);
  app = createServer();
  actor = await StaffMember.create({
    organizationId: "org-test",
    email: "catalog@example.invalid",
    firstName: "Catalog",
    lastName: "Tester",
    accountStatus: "active",
    isSuperAdmin: true,
  });
  await StaffCredential.create({
    staffId: actor._id,
    organizationId: "org-test",
    passwordHash: await hashPassword("Test-catalog-password!1"),
  });
  token = (
    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: actor.email, password: "Test-catalog-password!1" })
  ).body.data.accessToken;
  await seedCategories("org-test");
  const category = await ServiceCategory.findOne({ organizationId: "org-test" });
  categoryId = String(category?._id);
  marketId = String(
    (await Market.create({ organizationId: "org-test", slug: "las-vegas", name: "Las Vegas" }))._id
  );
  const location = await Location.create({ organizationId: "org-test", name: "Clinic" });
  const environment = await Environment.create({
    organizationId: "org-test",
    locationId: location._id,
    name: "Room",
  });
  base = {
    title: "Consultation",
    categoryId,
    locationId: String(location._id),
    environmentId: String(environment._id),
    durationMinutes: 30,
    capacityMin: 1,
    capacityMax: 2,
    basePriceCents: 10000,
    status: "active",
    lateCancellationFee: { enabled: false, windowHours: 24 },
    owner: "aerwell",
    modality: "physical",
    marketScope: "listed",
    marketIds: [marketId],
  };
});
const create = (body: Record<string, unknown> = base) =>
  request(app).post("/api/v1/services").set(auth()).send(body);
it("seeds eight categories and the four client plans idempotently", async () => {
  await seedCatalog("org-test");
  await seedCatalog("org-test");
  expect(await ServiceCategory.countDocuments()).toBe(8);
  const cats = await request(app).get("/api/v1/service-categories").set(auth());
  expect(cats.status).toBe(200);
  expect(cats.body.data).toHaveLength(8);
  const plans = await request(app).get("/api/v1/membership-plans").set(auth());
  expect(plans.status).toBe(200);
  expect(plans.body.data.map((p: { slug: string }) => p.slug)).toEqual([
    "alfred-free",
    "aerwell-continuum",
    "aerwell-essential",
    "everhaus-member",
  ]);
});
it("creates, reads, updates, scopes lookups and audits real services", async () => {
  const saved = await create();
  expect(saved.status).toBe(201);
  const id = saved.body.data.id;
  expect(saved.body.data.scheduledCount).toBe(0);
  const read = (await request(app).get(`/api/v1/services/${id}`).set(auth())).body.data;
  expect(read).toMatchObject({ owner: "aerwell", marketScope: "listed", marketIds: [marketId] });
  expect(read.slug).toBe("consultation");
  expect(read.membershipAccess).toBeUndefined();
  expect(read.version).toBe(0);
  const patched = await request(app)
    .patch(`/api/v1/services/${id}`)
    .set(auth())
    .send({ title: "Long consultation", capacityMax: 3 });
  expect(patched.status).toBe(200);
  expect(patched.body.data.capacityMax).toBe(3);
  expect(
    (await request(app).get("/api/v1/services/lookups").set(auth())).body.data.locations
  ).toHaveLength(1);
  expect(await AuditEvent.countDocuments({ targetType: "service", action: "created" })).toBe(1);
  expect(await AuditEvent.countDocuments({ targetType: "service", action: "updated" })).toBe(1);
});
it("filters both sides, escapes search regex and paginates filtered totals", async () => {
  await create({ ...base, title: "Consultation (A)" });
  await create({ ...base, title: "Consultation B", status: "inactive" });
  const other = await ServiceCategory.findOne({
    _id: { $ne: categoryId },
    organizationId: "org-test",
  });
  await create({ ...base, title: "Assessment", categoryId: String(other?._id) });
  for (const [filter, total] of [
    ["status=active", 2],
    ["status=inactive", 1],
    [`categoryId=${categoryId}`, 2],
    [`categoryId=${other?._id}`, 1],
    ["q=(A)", 1],
    ["q=missing", 0],
  ] as const) {
    const res = await request(app).get(`/api/v1/services?${filter}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.pagination.total).toBe(total);
  }
  const page = await request(app).get("/api/v1/services?limit=1&page=2&status=active").set(auth());
  expect(Object.keys(page.body.data).sort()).toEqual(["items", "pagination"]);
  expect(page.body.data.pagination).toEqual({
    total: 2,
    totalPages: 2,
    page: 2,
    limit: 1,
    hasNext: false,
    hasPrev: true,
  });
  const first = await request(app).get("/api/v1/services?limit=1&page=1&status=active").set(auth());
  expect(first.body.data.pagination).toEqual({
    total: 2,
    totalPages: 2,
    page: 1,
    limit: 1,
    hasNext: true,
    hasPrev: false,
  });
  const empty = await request(app).get("/api/v1/services?q=missing").set(auth());
  expect(empty.body.data.pagination).toEqual({
    total: 0,
    totalPages: 1,
    page: 1,
    limit: 20,
    hasNext: false,
    hasPrev: false,
  });
  expect(page.body.data.items).toHaveLength(1);
  expect((await request(app).get("/api/v1/services?status=bogus").set(auth())).status).toBe(400);
  expect((await request(app).get("/api/v1/services?categoryId=bad").set(auth())).status).toBe(400);
});
it.each([
  { title: "" },
  { categoryId: undefined },
  { durationMinutes: 0 },
  { durationMinutes: 1.5 },
  { capacityMin: 3 },
  { basePriceCents: -1 },
  { basePriceCents: 1.5 },
  { lateCancellationFee: { enabled: true, windowHours: 24 } },
  { lateCancellationFee: { enabled: true, amountCents: 0, windowHours: 24 } },
  { lateCancellationFee: { enabled: false, windowHours: 0 } },
  { imageKey: "foreign/key" },
  { assignedStaffIds: ["invalid"] },
  { membershipAccess: [] },
  { owner: "alfred" },
  { modality: "hybrid" },
  { marketScope: "all" },
  { marketIds: ["bad"] },
  { marketIds: ["a".repeat(24), "a".repeat(24)] },
  { bundleComponentIds: ["bad"] },
  { slug: "Not A Slug" },
  { locationId: null },
])("rejects invalid service values %j", async (patch) => {
  expect((await create({ ...base, ...patch })).status).toBe(400);
});
it("supports null retail, optional location, slugs, bundles and version conflicts", async () => {
  const member = await create({
    ...base,
    title: "Members Lounge",
    basePriceCents: null,
    locationId: null,
    environmentId: null,
    marketScope: "all",
    marketIds: [],
  });
  expect(member.status).toBe(201);
  expect(member.body.data).toMatchObject({
    basePriceCents: null,
    locationId: null,
    slug: "members-lounge",
  });
  expect((await create({ ...base, slug: "members-lounge" })).status).toBe(409);
  const again = await create({ ...base, title: "Members Lounge" });
  expect(again.body.data.slug).toMatch(/^members-lounge-[a-f0-9]{6}$/);
  const a = (await create({ ...base, title: "Part A" })).body.data.id;
  const bundle = await create({ ...base, title: "Bundle", bundleComponentIds: [a] });
  expect(bundle.status).toBe(201);
  const bundleId = bundle.body.data.id;
  const patch = (id: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/v1/services/${id}`).set(auth()).send(body);
  expect((await patch(bundleId, { bundleComponentIds: [bundleId] })).status).toBe(400);
  expect((await patch(a, { bundleComponentIds: [member.body.data.id] })).status).toBe(400);
  expect((await create({ ...base, title: "Nested", bundleComponentIds: [bundleId] })).status).toBe(
    400
  );
  expect(
    (
      await create({
        ...base,
        title: "Foreign",
        bundleComponentIds: [String(new Types.ObjectId())],
      })
    ).status
  ).toBe(400);
  expect((await create({ ...base, marketIds: [String(new Types.ObjectId())] })).status).toBe(400);
  expect((await patch(a, { slug: "renamed" })).status).toBe(400);
  const updated = await patch(a, { title: "Part A1", expectedVersion: 0 });
  expect(updated.body.data.version).toBe(1);
  const stale = await patch(a, { title: "Part A2", expectedVersion: 0 });
  expect(stale.status).toBe(409);
  expect(stale.body.code).toBe("VERSION_CONFLICT");
});
it("validates patched whole document and organization ownership of every reference", async () => {
  const saved = await create();
  expect(
    (
      await request(app)
        .patch(`/api/v1/services/${saved.body.data.id}`)
        .set(auth())
        .send({ capacityMin: 4 })
    ).status
  ).toBe(400);
  for (const field of ["categoryId", "locationId", "environmentId", "assignedTeamRoleId"]) {
    expect((await create({ ...base, [field]: String(new Types.ObjectId()) })).status).toBe(400);
  }
  expect((await create({ ...base, assignedStaffIds: [String(new Types.ObjectId())] })).status).toBe(
    400
  );
  const otherLocation = await Location.create({
    organizationId: "org-test",
    name: "Another clinic",
  });
  expect((await create({ ...base, locationId: String(otherLocation._id) })).status).toBe(400);
  const foreign = await Service.create({ ...base, organizationId: "other" });
  expect((await request(app).get(`/api/v1/services/${foreign._id}`).set(auth())).status).toBe(404);
  expect(
    (await request(app).patch(`/api/v1/services/${foreign._id}`).set(auth()).send({ title: "Bad" }))
      .status
  ).toBe(404);
  expect((await request(app).get("/api/v1/services/bad").set(auth())).status).toBe(400);
});
it("bulk activation/deactivation/archive never deletes and rejects mixed invalid ids atomically", async () => {
  const a = (await create()).body.data.id;
  const b = (await create({ ...base, title: "Second" })).body.data.id;
  const bulk = (ids: string[], action: string) =>
    request(app).post("/api/v1/services/bulk").set(auth()).send({ ids, action });
  expect((await bulk([a, b], "deactivate")).body.data.updated).toBe(2);
  expect(await Service.countDocuments({ status: "inactive" })).toBe(2);
  expect((await bulk([a, b], "activate")).status).toBe(200);
  expect((await bulk([a, String(new Types.ObjectId())], "archive")).status).toBe(404);
  expect(await Service.countDocuments({ deletedAt: null })).toBe(2);
  expect((await bulk([a, b], "archive")).status).toBe(200);
  expect(await Service.countDocuments()).toBe(2);
  expect((await request(app).get("/api/v1/services").set(auth())).body.data.pagination.total).toBe(
    0
  );
  expect((await request(app).get(`/api/v1/services/${a}`).set(auth())).status).toBe(404);
  expect((await bulk([], "archive")).status).toBe(400);
});
it("enforces view/edit permission on every route and supports scoped own assignments", async () => {
  const saved = await create();
  await StaffMember.updateOne(
    { _id: actor._id },
    {
      $set: {
        isSuperAdmin: false,
        permissionOverrides: [{ module: "SERVICES", level: "view", scope: "all" }],
      },
    }
  );
  for (const route of [
    "/services",
    "/services/lookups",
    `/services/${saved.body.data.id}`,
    "/service-categories",
    "/membership-plans",
  ])
    expect((await request(app).get(`/api/v1${route}`).set(auth())).status).toBe(200);
  expect((await create()).status).toBe(403);
  expect(
    (
      await request(app)
        .patch(`/api/v1/services/${saved.body.data.id}`)
        .set(auth())
        .send({ title: "No" })
    ).status
  ).toBe(403);
  expect(
    (
      await request(app)
        .post("/api/v1/services/bulk")
        .set(auth())
        .send({ ids: [saved.body.data.id], action: "deactivate" })
    ).status
  ).toBe(403);
  expect(
    (
      await request(app)
        .post("/api/v1/services/images/presign")
        .set(auth())
        .send({ contentType: "image/png", size: 100 })
    ).status
  ).toBe(403);
  await StaffMember.updateOne(
    { _id: actor._id },
    { $set: { permissionOverrides: [{ module: "SERVICES", level: "view", scope: "own" }] } }
  );
  expect((await request(app).get("/api/v1/services").set(auth())).body.data.pagination.total).toBe(
    0
  );
  await Service.updateOne({ _id: saved.body.data.id }, { $set: { assignedStaffIds: [actor._id] } });
  expect((await request(app).get("/api/v1/services").set(auth())).body.data.pagination.total).toBe(
    1
  );
  await StaffMember.updateOne({ _id: actor._id }, { $set: { permissionOverrides: [] } });
  for (const route of [
    "/services",
    "/services/lookups",
    `/services/${saved.body.data.id}`,
    "/service-categories",
    "/membership-plans",
  ])
    expect((await request(app).get(`/api/v1${route}`).set(auth())).status).toBe(403);
  expect((await request(app).get("/api/v1/services")).status).toBe(401);
});
it("validates and returns bound signed upload requests only for catalog editors", async () => {
  imageMocks.presign.mockResolvedValue({
    uploadId: "upload",
    url: "https://s3.example.invalid/signed",
    expiresIn: 300,
  });
  const r = await request(app)
    .post("/api/v1/services/images/presign")
    .set(auth())
    .send({ contentType: "image/png", size: 100 });
  expect(r.status).toBe(200);
  expect(r.body.data.expiresIn).toBe(300);
  expect(
    (
      await request(app)
        .post("/api/v1/services/images/presign")
        .set(auth())
        .send({ contentType: "image/svg+xml", size: 100 })
    ).status
  ).toBe(400);
});
