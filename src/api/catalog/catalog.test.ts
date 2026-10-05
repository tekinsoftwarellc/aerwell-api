import type { Request } from "express";
import { Types } from "mongoose";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { evaluateEntitlement } from "../entitlement/evaluate.js";
import { loadCatalogSnapshot } from "../entitlement/snapshot.js";
import { Location } from "../location/location.model.js";
import { Service, ServiceCategory } from "../service/service.model.js";
import { seedCatalog } from "../service/service.seed.js";
import { StaffMember } from "../staff/staff.model.js";
import { CatalogRevision, DeliveryModifier, Market, MembershipPlan } from "./catalog.model.js";
import { saveVersioned } from "./versioning.js";

const ORG = "org-test";
let app: ReturnType<typeof createServer>;
let token: string;
let staffId: Types.ObjectId;
const auth = () => ({ authorization: `Bearer ${token}` });
const ids: Record<string, string> = {};
const id = (key: string) => ids[key] as string;
beforeEach(async () => {
  app = createServer();
  const fixture = await staffFixture(true);
  token = fixture.accessToken;
  staffId = fixture.staff._id;
  await seedCatalog(ORG);
  for (const s of await Service.find({ organizationId: ORG })) ids[String(s.slug)] = String(s._id);
  for (const p of await MembershipPlan.find({ organizationId: ORG }))
    ids[String(p.slug)] = String(p._id);
  ids["las-vegas"] = String(
    (await Market.findOne({ organizationId: ORG, slug: "las-vegas" }))?._id
  );
  ids["mobile"] = String((await DeliveryModifier.findOne({ organizationId: ORG }))?._id);
});
const get = (path: string) => request(app).get(`/api/v1${path}`).set(auth());
const send = (method: "post" | "patch", path: string, body: unknown) =>
  request(app)
    [method](`/api/v1${path}`)
    .set(auth())
    .send(body as object);
const preview = (body: Record<string, unknown>) =>
  send("post", "/entitlements/preview", {
    marketId: ids["las-vegas"],
    at: "2026-03-01T17:00:00.000Z",
    ...body,
  });
const member = (slug: string) => [{ planId: ids[slug], startedAt: "2026-01-15T08:00:00.000Z" }];
const permit = (overrides: { module: string; level: string }[]) =>
  StaffMember.updateOne(
    { _id: staffId },
    {
      $set: {
        isSuperAdmin: false,
        permissionOverrides: overrides.map((o) => ({ ...o, scope: "all" })),
      },
    }
  );

describe("client catalog seed", () => {
  it("seeds every client price idempotently without overwriting edits", async () => {
    await Service.updateOne({ _id: ids["dexa-scan"] }, { $set: { basePriceCents: 18000 } });
    await seedCatalog(ORG);
    expect(await Service.countDocuments({ organizationId: ORG })).toBe(6);
    expect(await MembershipPlan.countDocuments({ organizationId: ORG })).toBe(2);
    expect(await Market.countDocuments({ organizationId: ORG })).toBe(1);
    expect(await DeliveryModifier.countDocuments({ organizationId: ORG })).toBe(1);
    expect(await ServiceCategory.countDocuments({ organizationId: ORG })).toBe(7);
    expect((await Service.findById(ids["dexa-scan"]))?.basePriceCents).toBe(18000);
    const prices = Object.fromEntries(
      (await Service.find({ organizationId: ORG })).map((s) => [s.slug, s.basePriceCents])
    );
    expect(prices).toEqual({
      "comprehensive-blood-panel": 59500,
      "dexa-scan": 18000,
      "vo2-max-test": 17500,
      "clinician-telehealth-visit": 25000,
      "assessment-clinician-review": null,
      "advanced-assessment": 99500,
    });
    const plans = (await get("/membership-plans")).body.data;
    expect(
      plans.map((p: { slug: string; priceCents: number | null }) => [p.slug, p.priceCents])
    ).toEqual([
      ["aerwell-continuum", 29900],
      ["aerwell-essential", 19900],
    ]);
    const bundle = await Service.findById(ids["advanced-assessment"]);
    expect(bundle?.bundleComponentIds.map(String).sort()).toEqual(
      ["comprehensive-blood-panel", "dexa-scan", "vo2-max-test", "assessment-clinician-review"]
        .map((s) => ids[s])
        .sort()
    );
    expect((await DeliveryModifier.findById(ids["mobile"]))?.amountCents).toBe(12000);
  });
  it("services carry no owner and the owner filter is gone", async () => {
    const list = (await get("/services?limit=100")).body.data;
    expect(list.pagination.total).toBe(6);
    expect(list.items.every((s: Record<string, unknown>) => !("owner" in s))).toBe(true);
    expect((await get("/services?owner=aerwell")).status).toBe(400);
    const plans = (await get("/membership-plans")).body.data as Record<string, unknown>[];
    for (const field of ["brand", "isBaseline", "restrictedOwners"])
      expect(plans.some((p) => field in p)).toBe(false);
  });
});

describe("seeded database quotes (loader + pure evaluator)", () => {
  it("reproduces acceptance examples from the stored configuration", async () => {
    const catalog = await loadCatalogSnapshot(ORG);
    const quote = (slug: string, plans: string[], extra: Record<string, unknown> = {}) =>
      evaluateEntitlement(catalog, {
        serviceId: id(slug),
        marketId: id("las-vegas"),
        deliveryMethod: "standard",
        at: new Date("2026-03-01T17:00:00.000Z"),
        now: new Date("2026-02-20T12:00:00.000Z"),
        memberships: plans.map((p) => ({
          id: p,
          planId: id(p),
          status: "active" as const,
          startedAt: new Date("2026-01-15T08:00:00.000Z"),
        })),
        ...extra,
      });
    const essential = ["aerwell-essential"];
    expect(
      quote("comprehensive-blood-panel", essential, { deliveryMethod: "mobile_phlebotomy" })
        .finalCents
    ).toBe(71500);
    expect(quote("dexa-scan", essential, { marketId: null }).denialReason).toBe(
      "MARKET_UNAVAILABLE"
    );
    expect(quote("dexa-scan", []).denialReason).toBe("NOT_ELIGIBLE");
    expect(quote("dexa-scan", essential)).toMatchObject({ decision: "retail", finalCents: 17500 });
    expect(quote("vo2-max-test", ["aerwell-continuum"]).finalCents).toBe(17500);
    expect(quote("advanced-assessment", essential).decision).toBe("allowance");
  });
});

describe("configuration edits through the API change quotes", () => {
  it("Continuum allowance 4 -> 6 and mobile fee 12000 -> 15000, versioned, audited and revisioned", async () => {
    const usage = { [`${ids["aerwell-continuum"]}:${ids["advanced-assessment"]}`]: 4 };
    const before = await preview({
      serviceId: ids["advanced-assessment"],
      memberships: member("aerwell-continuum"),
      usage,
    });
    expect(before.status).toBe(200);
    expect(before.body.data.finalCents).toBe(99500);
    const plan = (await get(`/membership-plans/${ids["aerwell-continuum"]}`)).body.data;
    const benefits = plan.benefits.map(
      ({ id, ...b }: { id: string; serviceId: string; includedQuantity: number }) =>
        b.serviceId === ids["advanced-assessment"] ? { ...b, includedQuantity: 6 } : b
    );
    const patched = await send("patch", `/membership-plans/${plan.id}`, {
      benefits,
      expectedVersion: plan.version,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data.version).toBe(plan.version + 1);
    const after = await preview({
      serviceId: ids["advanced-assessment"],
      memberships: member("aerwell-continuum"),
      usage,
    });
    expect(after.body.data).toMatchObject({ decision: "allowance", finalCents: 0 });
    expect(after.body.data.ruleVersion).toContain(`plan:${plan.id}@${plan.version + 1}`);
    const stale = await send("patch", `/membership-plans/${plan.id}`, {
      name: "Stale",
      expectedVersion: plan.version,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");

    const mobile = {
      serviceId: ids["comprehensive-blood-panel"],
      deliveryMethod: "mobile_phlebotomy",
      memberships: member("aerwell-essential"),
    };
    expect((await preview(mobile)).body.data.finalCents).toBe(71500);
    expect(
      (await send("patch", `/delivery-modifiers/${ids["mobile"]}`, { amountCents: 15000 })).status
    ).toBe(200);
    expect((await preview(mobile)).body.data).toMatchObject({
      feesCents: 15000,
      finalCents: 74500,
    });

    const revisions = await get(
      `/catalog-revisions?entityType=membership_plan&entityId=${plan.id}`
    );
    expect(revisions.body.data.items.map((r: { version: number }) => r.version)).toEqual([
      plan.version + 1,
      plan.version,
    ]);
    expect(
      revisions.body.data.items[0].snapshot.benefits.find(
        (b: { serviceId: string }) => b.serviceId === ids["advanced-assessment"]
      ).includedQuantity
    ).toBe(6);
    expect(
      await AuditEvent.countDocuments({ targetType: "membership_plan", action: "updated" })
    ).toBe(1);
    expect(
      await AuditEvent.countDocuments({ targetType: "delivery_modifier", action: "updated" })
    ).toBe(1);
    expect(
      (await get(`/catalog-revisions?entityType=market&entityId=${ids["las-vegas"]}`)).body.data
        .pagination.total
    ).toBe(1);
    await expect(CatalogRevision.updateOne({}, { $set: { version: 99 } })).rejects.toThrow(
      /append-only/
    );
  });
  it("preview validates input and reports denials without writing anything", async () => {
    expect((await preview({ serviceId: "bad" })).status).toBe(400);
    expect(
      (
        await preview({
          serviceId: ids["dexa-scan"],
          memberships: [...member("aerwell-essential"), ...member("aerwell-essential")],
        })
      ).status
    ).toBe(400);
    const denied = await preview({ serviceId: ids["dexa-scan"] });
    expect(denied.body.data).toMatchObject({ bookable: false, denialReason: "NOT_ELIGIBLE" });
    expect(
      (await preview({ serviceId: String(new Types.ObjectId()) })).body.data.denialReason
    ).toBe("SERVICE_NOT_FOUND");
    expect(
      await AuditEvent.countDocuments({
        targetType: { $in: ["membership_plan", "service", "market", "delivery_modifier"] },
      })
    ).toBe(0);
  });
});

describe("membership plan validation", () => {
  const plan = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
    slug: "trial-plan",
    name: "Trial",
    priceCents: 5000,
    billingTerm: "monthly",
    benefits: [],
    ...patch,
  });
  const benefit = (service: string, patch: Record<string, unknown> = {}) => ({
    serviceId: ids[service],
    access: "eligible",
    ...patch,
  });
  it("creates a plan with defaults and rejects a duplicate slug", async () => {
    const created = await send(
      "post",
      "/membership-plans",
      plan({
        benefits: [benefit("dexa-scan", { pricing: { mode: "discount", discountBps: 500 } })],
      })
    );
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: "active", clinicianChat: false, version: 0 });
    expect(created.body.data.benefits[0]).toMatchObject({
      id: ids["dexa-scan"],
      includedQuantity: 0,
      exhaustion: "paid",
    });
    expect((await send("post", "/membership-plans", plan())).status).toBe(409);
  });
  it.each([
    [
      "exclusive access on a retail service",
      {
        benefits: [{ serviceId: "dexa-scan", access: "exclusive", pricing: { mode: "included" } }],
      },
    ],
    [
      "a discount on a service without retail",
      {
        benefits: [
          {
            serviceId: "assessment-clinician-review",
            access: "eligible",
            pricing: { mode: "discount", discountBps: 1000 },
          },
        ],
      },
    ],
    [
      "an allowance without a period",
      { benefits: [{ serviceId: "dexa-scan", access: "eligible", includedQuantity: 2 }] },
    ],
    [
      "a period without an allowance",
      { benefits: [{ serviceId: "dexa-scan", access: "eligible", period: { unit: "year" } }] },
    ],
    [
      "zero basis points",
      {
        benefits: [
          {
            serviceId: "dexa-scan",
            access: "eligible",
            pricing: { mode: "discount", discountBps: 0 },
          },
        ],
      },
    ],
    [
      "over 10000 basis points",
      {
        benefits: [
          {
            serviceId: "dexa-scan",
            access: "eligible",
            pricing: { mode: "discount", discountBps: 10001 },
          },
        ],
      },
    ],
    [
      "fractional basis points",
      {
        benefits: [
          {
            serviceId: "dexa-scan",
            access: "eligible",
            pricing: { mode: "discount", discountBps: 12.5 },
          },
        ],
      },
    ],
    [
      "fractional custom cents",
      {
        benefits: [
          {
            serviceId: "dexa-scan",
            access: "eligible",
            pricing: { mode: "custom", customPriceCents: 99.5 },
          },
        ],
      },
    ],
    [
      "a priced ineligible benefit",
      {
        benefits: [{ serviceId: "dexa-scan", access: "ineligible", pricing: { mode: "included" } }],
      },
    ],
    [
      "duplicate service benefits",
      {
        benefits: [
          { serviceId: "dexa-scan", access: "eligible" },
          { serviceId: "dexa-scan", access: "ineligible" },
        ],
      },
    ],
    ["an unknown service", { benefits: [{ serviceId: "missing", access: "eligible" }] }],
    ["a removed brand field", { brand: "aerwell" }],
    ["a removed baseline flag", { isBaseline: false }],
    ["removed restricted owners", { restrictedOwners: [] }],
    ["fractional plan price", { priceCents: 19.99 }],
    [
      "an allowance priced as included",
      {
        benefits: [
          {
            serviceId: "dexa-scan",
            access: "eligible",
            includedQuantity: 2,
            period: { unit: "year" },
            pricing: { mode: "included" },
          },
        ],
      },
    ],
    [
      "an allowance with a 100% discount",
      {
        benefits: [
          {
            serviceId: "dexa-scan",
            access: "eligible",
            includedQuantity: 2,
            period: { unit: "year" },
            pricing: { mode: "discount", discountBps: 10000 },
          },
        ],
      },
    ],
    ["an unknown field", { tiers: [] }],
  ])("rejects %s", async (_label, patch: Record<string, unknown>) => {
    const body = plan(patch);
    body["benefits"] = (body["benefits"] as { serviceId: string }[]).map((b) => ({
      ...b,
      serviceId: ids[b.serviceId] ?? String(new Types.ObjectId()),
    }));
    expect((await send("post", "/membership-plans", body)).status).toBe(400);
  });
  it("rejects legacy edits and unknown ids", async () => {
    const essential = `/membership-plans/${ids["aerwell-essential"]}`;
    expect((await send("patch", essential, { name: "Essential (renamed)" })).status).toBe(200);
    const legacy = await MembershipPlan.create({ organizationId: ORG, name: "Aerwell" });
    expect((await send("patch", `/membership-plans/${legacy._id}`, { name: "x" })).status).toBe(
      400
    );
    expect((await get("/membership-plans")).body.data).toHaveLength(2);
    expect((await get(`/membership-plans/${new Types.ObjectId()}`)).status).toBe(404);
    expect((await send("patch", essential, { slug: "renamed" })).status).toBe(400);
    expect((await send("patch", essential, {})).status).toBe(400);
    const foreign = await MembershipPlan.create({ organizationId: "other", slug: "x", name: "X" });
    expect((await get(`/membership-plans/${foreign._id}`)).status).toBe(404);
  });
});

describe("markets and delivery modifiers", () => {
  it("creates and edits markets with organization-checked locations", async () => {
    const location = await Location.create({ organizationId: ORG, name: "Reno clinic" });
    const created = await send("post", "/markets", {
      slug: "reno",
      name: "Reno",
      locationIds: [String(location._id)],
    });
    expect(created.status).toBe(201);
    expect((await send("post", "/markets", { slug: "reno", name: "Again" })).status).toBe(409);
    const foreign = await Location.create({ organizationId: "other", name: "Elsewhere" });
    expect(
      (
        await send("post", "/markets", {
          slug: "far",
          name: "Far",
          locationIds: [String(foreign._id)],
        })
      ).status
    ).toBe(400);
    const patched = await send("patch", `/markets/${created.body.data.id}`, { active: false });
    expect(patched.body.data).toMatchObject({ active: false, version: 1 });
    expect((await get("/markets")).body.data.map((m: { slug: string }) => m.slug)).toEqual([
      "las-vegas",
      "reno",
    ]);
    // A new market needs no code change: list DEXA there and quote it.
    await send("patch", `/services/${ids["dexa-scan"]}`, {
      marketIds: [ids["las-vegas"], created.body.data.id],
    });
    await send("patch", `/markets/${created.body.data.id}`, { active: true });
    expect(
      (
        await preview({
          serviceId: ids["dexa-scan"],
          marketId: created.body.data.id,
          memberships: member("aerwell-essential"),
        })
      ).body.data.finalCents
    ).toBe(17500);
  });
  it("validates delivery modifiers", async () => {
    const body = {
      slug: "home_visit",
      name: "Home visit",
      amountCents: 5000,
      serviceIds: [ids["dexa-scan"]],
    };
    expect((await send("post", "/delivery-modifiers", body)).status).toBe(201);
    for (const bad of [
      { ...body, slug: "standard" },
      { ...body, slug: "other", amountCents: 1.5 },
      { ...body, slug: "other", serviceIds: [] },
      { ...body, slug: "other", serviceIds: [String(new Types.ObjectId())] },
      { ...body, slug: "other", marketIds: [ids["las-vegas"]] },
      { ...body, slug: "other", marketScope: "listed", marketIds: [String(new Types.ObjectId())] },
    ])
      expect((await send("post", "/delivery-modifiers", bad)).status).toBe(400);
    expect((await send("post", "/delivery-modifiers", body)).status).toBe(409);
    expect(
      (
        await send("patch", `/delivery-modifiers/${ids["mobile"]}`, {
          marketIds: [ids["las-vegas"]],
        })
      ).status
    ).toBe(400);
    expect(
      (
        await send("patch", `/delivery-modifiers/${ids["mobile"]}`, {
          marketScope: "listed",
          marketIds: [ids["las-vegas"]],
        })
      ).body.data.marketScope
    ).toBe("listed");
    expect((await get("/delivery-modifiers")).body.data).toHaveLength(2);
  });
});

describe("permissions", () => {
  const writes: [string, "post" | "patch", () => string, () => unknown][] = [
    ["BILLING", "post", () => "/membership-plans", () => ({ slug: "p2", name: "P2" })],
    [
      "BILLING",
      "patch",
      () => `/membership-plans/${ids["aerwell-essential"]}`,
      () => ({ name: "Essential+" }),
    ],
    [
      "BILLING",
      "post",
      () => "/delivery-modifiers",
      () => ({ slug: "m2", name: "M2", amountCents: 1, serviceIds: [ids["dexa-scan"]] }),
    ],
    [
      "BILLING",
      "patch",
      () => `/delivery-modifiers/${ids["mobile"]}`,
      () => ({ amountCents: 13000 }),
    ],
    ["SYSTEM_SETTINGS", "post", () => "/markets", () => ({ slug: "reno", name: "Reno" })],
    [
      "SYSTEM_SETTINGS",
      "patch",
      () => `/markets/${ids["las-vegas"]}`,
      () => ({ name: "Las Vegas NV" }),
    ],
  ];
  it.each(writes)("%s edit is required for %s %s", async (module, method, path, body) => {
    await permit([
      { module: "SERVICES", level: "master" },
      { module, level: "view" },
    ]);
    expect((await send(method, path(), body())).status).toBe(403);
    await permit([
      { module: "SERVICES", level: "view" },
      { module, level: "edit" },
    ]);
    expect((await send(method, path(), body())).status).toBeLessThan(300);
  });
  it("reads need SERVICES view", async () => {
    const reads = [
      "/markets",
      "/membership-plans",
      `/membership-plans/${ids["aerwell-essential"]}`,
      "/delivery-modifiers",
      `/catalog-revisions?entityType=market&entityId=${ids["las-vegas"]}`,
    ];
    await permit([{ module: "SERVICES", level: "view" }]);
    for (const path of reads) expect((await get(path)).status).toBe(200);
    expect((await preview({ serviceId: ids["dexa-scan"] })).status).toBe(200);
    await permit([
      { module: "SERVICES", level: "none" },
      { module: "BILLING", level: "master" },
      { module: "SYSTEM_SETTINGS", level: "master" },
    ]);
    for (const path of reads) expect((await get(path)).status).toBe(403);
    expect((await preview({ serviceId: ids["dexa-scan"] })).status).toBe(403);
    expect((await request(app).get("/api/v1/markets")).status).toBe(401);
  });
});

describe("concurrent configuration writes", () => {
  it("a second writer holding a stale document gets 409, never a silent overwrite", async () => {
    const req = { staff: { organizationId: ORG, _id: staffId } } as unknown as Request;
    const first = await Market.findById(ids["las-vegas"]);
    const second = await Market.findById(ids["las-vegas"]);
    first?.set({ name: "Las Vegas A" });
    second?.set({ name: "Las Vegas B" });
    await saveVersioned(req, "market", first as NonNullable<typeof first>, "updated");
    await expect(
      saveVersioned(req, "market", second as NonNullable<typeof second>, "updated")
    ).rejects.toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });
    expect((await Market.findById(ids["las-vegas"]))?.name).toBe("Las Vegas A");
    expect(await CatalogRevision.countDocuments({ entityId: ids["las-vegas"] })).toBe(2);
  });
});

describe("configuration guards from review", () => {
  it("refuses a retail change that would break a plan benefit", async () => {
    const patch = (slug: string, body: Record<string, unknown>) =>
      send("patch", `/services/${ids[slug]}`, body);
    const addBenefit = async (planSlug: string, benefit: Record<string, unknown>) => {
      const plan = (await get(`/membership-plans/${ids[planSlug]}`)).body.data;
      const benefits = [
        ...plan.benefits.map(({ id, ...b }: { id: string }) => b),
        { ...benefit, serviceId: ids[String(benefit["serviceId"])] },
      ];
      expect((await send("patch", `/membership-plans/${plan.id}`, { benefits })).status).toBe(200);
    };
    await addBenefit("aerwell-essential", {
      serviceId: "dexa-scan",
      access: "eligible",
      pricing: { mode: "discount", discountBps: 1000 },
    });
    await addBenefit("aerwell-continuum", {
      serviceId: "assessment-clinician-review",
      access: "exclusive",
      pricing: { mode: "included" },
    });
    const discounted = await patch("dexa-scan", { basePriceCents: null });
    expect(discounted.status).toBe(400);
    expect(discounted.body.message).toMatch(/Aerwell Essential/);
    expect((await patch("assessment-clinician-review", { basePriceCents: 5000 })).status).toBe(400);
    expect((await patch("dexa-scan", { basePriceCents: 18000 })).status).toBe(200);
    expect((await patch("vo2-max-test", { basePriceCents: null })).status).toBe(200);
  });
});
