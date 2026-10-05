import { Types } from "mongoose";
import { expect, it } from "vitest";
import { Appointment } from "../api/appointment/appointment.model.js";
import { DeliveryModifier, MembershipPlan } from "../api/catalog/catalog.model.js";
import { MemberMembership } from "../api/member/member.model.js";
import { Service, ServiceCategory } from "../api/service/service.model.js";
import { cleanupEverhaus } from "./cleanup-everhaus.service.js";

const ORG = "org-test";
const id = () => new Types.ObjectId();

// The legacy shape as deployed, written natively (today's schemas strip it).
async function legacyState() {
  const [wellness, clinician] = [id(), id()];
  await ServiceCategory.collection.insertMany([
    { _id: wellness, organizationId: ORG, name: "Everhaus wellness", color: "#000", sortOrder: 7 },
    { _id: clinician, organizationId: ORG, name: "Clinician visits", color: "#111", sortOrder: 6 },
  ]);
  const s = { unused: id(), booked: id(), dexa: id(), bundle: id() };
  await Service.collection.insertMany([
    {
      _id: s.unused,
      organizationId: ORG,
      title: "Red light",
      owner: "everhaus",
      categoryId: wellness,
    },
    {
      _id: s.booked,
      organizationId: ORG,
      title: "Sanctuary",
      owner: "everhaus",
      categoryId: clinician,
    },
    { _id: s.dexa, organizationId: ORG, title: "DEXA", owner: "aerwell", categoryId: clinician },
    {
      _id: s.bundle,
      organizationId: ORG,
      title: "Bundle",
      owner: "aerwell",
      categoryId: clinician,
      bundleComponentIds: [s.unused, s.dexa],
    },
  ]);
  const p = { free: id(), held: id(), essential: id(), tier: id() };
  const benefit = (serviceId: Types.ObjectId) => ({ id: String(serviceId), serviceId });
  await MembershipPlan.collection.insertMany([
    { _id: p.free, organizationId: ORG, slug: "alfred-free", brand: "alfred", isBaseline: true },
    { _id: p.held, organizationId: ORG, slug: "everhaus-member", brand: "everhaus" },
    {
      _id: p.essential,
      organizationId: ORG,
      slug: "aerwell-essential",
      brand: "aerwell",
      isBaseline: false,
      restrictedOwners: [],
      benefits: [benefit(s.unused), benefit(s.booked), benefit(s.dexa)],
    },
    { _id: p.tier, organizationId: ORG, name: "Everhaus", brand: "everhaus" },
  ]);
  await MemberMembership.collection.insertOne({ organizationId: ORG, planId: p.held });
  await Appointment.collection.insertOne({
    organizationId: ORG,
    serviceId: s.booked,
    price: { selection: { planId: String(p.tier) } },
  });
  await DeliveryModifier.collection.insertOne({
    organizationId: ORG,
    slug: "mobile",
    serviceIds: [s.unused, s.dexa],
  });
  return { s, p, wellness };
}

it("dry-run counts only; the real run removes unreferenced legacy data idempotently", async () => {
  const { s, p, wellness } = await legacyState();
  const expected = {
    servicesDeleted: 1,
    servicesSkippedReferenced: 1,
    categoryDeleted: 1,
    categorySkippedReferenced: 0,
    plansDeleted: 1,
    plansSkippedReferenced: 2,
    benefitsPulledFromPlans: 1,
    modifiersUpdated: 1,
    bundlesUpdated: 1,
    serviceOwnerUnset: 2,
    planFieldsUnset: 1,
  };
  expect(await cleanupEverhaus({ dryRun: true })).toEqual({ dryRun: true, ...expected });
  expect(await Service.collection.countDocuments()).toBe(4);
  expect(await MembershipPlan.collection.countDocuments()).toBe(4);
  expect(await Service.collection.countDocuments({ owner: { $exists: true } })).toBe(4);

  expect(await cleanupEverhaus({ dryRun: false })).toEqual({ dryRun: false, ...expected });
  const services = await Service.collection.find().toArray();
  expect(services.map((d) => String(d._id)).sort()).toEqual(
    [s.booked, s.dexa, s.bundle].map(String).sort()
  );
  // A still-referenced legacy service keeps its marker so a later run can find it.
  expect(services.filter((d) => "owner" in d).map((d) => String(d._id))).toEqual([
    String(s.booked),
  ]);
  const bundle = services.find((d) => String(d._id) === String(s.bundle));
  expect(bundle?.["bundleComponentIds"].map(String)).toEqual([String(s.dexa)]);
  expect(await ServiceCategory.collection.countDocuments({ _id: wellness })).toBe(0);
  const plans = await MembershipPlan.collection.find().toArray();
  expect(plans.map((d) => String(d._id)).sort()).toEqual(
    [p.held, p.essential, p.tier].map(String).sort()
  );
  const essential = plans.find((d) => String(d._id) === String(p.essential));
  expect(essential).not.toHaveProperty("brand");
  expect(essential).not.toHaveProperty("isBaseline");
  expect(essential).not.toHaveProperty("restrictedOwners");
  expect(essential?.["benefits"].map((b: { serviceId: unknown }) => String(b.serviceId))).toEqual(
    [s.booked, s.dexa].map(String)
  );
  const modifier = await DeliveryModifier.collection.findOne();
  expect(modifier?.["serviceIds"].map(String)).toEqual([String(s.dexa)]);

  const again = await cleanupEverhaus({ dryRun: false });
  expect(again).toMatchObject({
    servicesDeleted: 0,
    servicesSkippedReferenced: 1,
    categoryDeleted: 0,
    plansDeleted: 0,
    plansSkippedReferenced: 2,
    benefitsPulledFromPlans: 0,
    modifiersUpdated: 0,
    bundlesUpdated: 0,
    serviceOwnerUnset: 0,
    planFieldsUnset: 0,
  });
});

it("keeps the legacy category while any service still uses it", async () => {
  const category = id();
  await ServiceCategory.collection.insertOne({ _id: category, name: "Everhaus wellness" });
  await Service.collection.insertOne({ title: "Kept", categoryId: category });
  expect(await cleanupEverhaus({ dryRun: false })).toMatchObject({
    categoryDeleted: 0,
    categorySkippedReferenced: 1,
  });
  expect(await ServiceCategory.collection.countDocuments()).toBe(1);
});
