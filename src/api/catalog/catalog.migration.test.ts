import { Types } from "mongoose";
import { expect, it } from "vitest";
import { Service } from "../service/service.model.js";
import { seedCatalog, seedCategories } from "../service/service.seed.js";
import { migrateLegacyCatalog } from "./catalog.migration.js";
import { MembershipPlan } from "./catalog.model.js";

const ORG = "org-test";
const LEGACY_INDEX = "organizationId_1_brand_1";
// Recreate what the original W4 build deployed: a unique brand index, Tier 1/2/3
// placeholder plans and services carrying per-tier membershipAccess.
async function legacyState() {
  await MembershipPlan.init();
  await MembershipPlan.collection.createIndex(
    { organizationId: 1, brand: 1 },
    { unique: true, name: LEGACY_INDEX }
  );
  const [aerwell] = await MembershipPlan.collection
    .insertMany([
      {
        organizationId: ORG,
        name: "Aerwell",
        brand: "aerwell",
        tiers: [{ id: "tier-1", name: "Tier 1", pricePending: true }],
      },
      {
        organizationId: ORG,
        name: "Partner",
        brand: "partner",
        tiers: [{ id: "membership", name: "Membership" }],
      },
    ])
    .then((r) => Object.values(r.insertedIds));
  await seedCategories(ORG);
  const categoryId = new Types.ObjectId();
  const legacy = await Service.collection.insertMany([
    {
      organizationId: ORG,
      title: "Testosterone Optimization",
      categoryId,
      durationMinutes: 30,
      capacityMin: 1,
      capacityMax: 1,
      basePriceCents: 15000,
      status: "active",
      deletedAt: null,
      membershipAccess: [
        { membershipPlanId: aerwell, enabled: true, tiers: [{ tierId: "tier-1", mode: "off" }] },
      ],
      __v: 0,
    },
    {
      organizationId: ORG,
      title: "Testosterone Optimization",
      categoryId,
      durationMinutes: 30,
      capacityMin: 1,
      capacityMax: 1,
      basePriceCents: 9500,
      status: "active",
      deletedAt: null,
      __v: 0,
    },
  ]);
  return Object.values(legacy.insertedIds);
}

it("the deployed brand index blocks the new plans until the migration drops it", async () => {
  await legacyState();
  await expect(seedCatalog(ORG)).rejects.toThrow(/E11000/);
  const report = await migrateLegacyCatalog();
  expect(report.droppedLegacyIndex).toBe(true);
  await seedCatalog(ORG);
  expect(
    await MembershipPlan.countDocuments({
      organizationId: ORG,
      status: "active",
      slug: { $type: "string" },
    })
  ).toBe(2);
  const indexes = (await MembershipPlan.collection.indexes()).map((i) => i.name);
  expect(indexes).not.toContain(LEGACY_INDEX);
});

it("archives legacy tier plans, strips tier access and backfills safe service defaults idempotently", async () => {
  const [withAccess, plain] = await legacyState();
  const first = await migrateLegacyCatalog();
  expect(first).toMatchObject({
    archivedLegacyPlans: 2,
    strippedTierAccess: 1,
    backfilledServices: 2,
  });
  const plans = await MembershipPlan.collection.find({ organizationId: ORG }).toArray();
  expect(plans.every((p) => p["status"] === "archived" && Array.isArray(p["tiers"]))).toBe(true);
  const services = await Service.collection
    .find({ organizationId: ORG })
    .sort({ basePriceCents: -1 })
    .toArray();
  for (const s of services) {
    expect(s).toMatchObject({
      modality: "physical",
      marketScope: "listed",
      marketIds: [],
      bundleComponentIds: [],
      version: 0,
    });
    expect(s["owner"]).toBeUndefined();
    expect(s["membershipAccess"]).toBeUndefined();
  }
  expect(services.map((s) => s["slug"])).toEqual([
    `testosterone-optimization-${String(withAccess).slice(-6)}`,
    `testosterone-optimization-${String(plain).slice(-6)}`,
  ]);
  // Fail closed: a migrated service is offered in no market until configured.
  const second = await migrateLegacyCatalog();
  expect(second).toMatchObject({
    droppedLegacyIndex: false,
    archivedLegacyPlans: 0,
    strippedTierAccess: 0,
    backfilledServices: 0,
  });
  const doc = await Service.findById(withAccess);
  doc?.set({ title: "Testosterone Optimization Program" });
  await doc?.save();
  expect(doc?.get("version")).toBe(1);
});
