// One-way migration from the original W4 placeholder catalog (Aerwell Tier 1/2/3
// + single Everhaus tier, per-service membershipAccess) to the client catalog.
// Mongoose never drops indexes, and strict schemas strip unknown paths from
// updates, so this works on the native collections. Idempotent.
import { Service } from "../service/service.model.js";
import { MembershipPlan } from "./catalog.model.js";

const LEGACY_PLAN_INDEX = "organizationId_1_brand_1";
const slugify = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "service";

async function dropLegacyPlanIndex(): Promise<boolean> {
  const collection = MembershipPlan.collection;
  const exists = await collection.indexExists(LEGACY_PLAN_INDEX).catch(() => false);
  if (exists) await collection.dropIndex(LEGACY_PLAN_INDEX);
  return exists;
}

async function backfillServices(): Promise<number> {
  const collection = Service.collection;
  const defaults = {
    owner: "aerwell",
    modality: "physical",
    // Fail closed: a migrated service is offered nowhere until staff configure it.
    marketScope: "listed",
    marketIds: [],
    bundleComponentIds: [],
    version: 0,
  };
  let changed = 0;
  for await (const doc of collection.find({ slug: { $exists: false } })) {
    const set: Record<string, unknown> = {
      slug: `${slugify(String(doc["title"]))}-${String(doc._id).slice(-6)}`,
    };
    for (const [key, value] of Object.entries(defaults))
      if (doc[key] === undefined) set[key] = value;
    await collection.updateOne(
      { _id: doc._id, slug: { $exists: false } },
      { $set: set, $unset: { __v: "" } }
    );
    changed++;
  }
  return changed;
}

export async function migrateLegacyCatalog() {
  const droppedLegacyIndex = await dropLegacyPlanIndex();
  const archived = await MembershipPlan.collection.updateMany(
    { slug: { $exists: false }, status: { $ne: "archived" } },
    { $set: { status: "archived" } }
  );
  const stripped = await Service.collection.updateMany(
    { membershipAccess: { $exists: true } },
    { $unset: { membershipAccess: "" } }
  );
  return {
    droppedLegacyIndex,
    archivedLegacyPlans: archived.modifiedCount,
    strippedTierAccess: stripped.modifiedCount,
    backfilledServices: await backfillServices(),
  };
}
