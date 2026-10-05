// One-off removal of the legacy Everhaus / Alfred Free catalog from the Aerwell
// database. Strict schemas strip the removed paths, so this works on the native
// collections. Idempotent; reports counts only, never document contents.
import type { mongo } from "mongoose";
import {
  AllowanceLedgerEntry,
  Appointment,
  AssessmentEpisode,
} from "../api/appointment/appointment.model.js";
import { DeliveryModifier, MembershipPlan } from "../api/catalog/catalog.model.js";
import { MemberMembership } from "../api/member/member.model.js";
import { Service, ServiceCategory } from "../api/service/service.model.js";

type Collection = mongo.Collection;
type ObjectId = mongo.ObjectId;

const LEGACY_OWNER = "everhaus";
const LEGACY_CATEGORY = "Everhaus wellness";
const LEGACY_PLAN_FILTER = {
  $or: [
    { slug: { $in: ["alfred-free", "everhaus-member"] } },
    { brand: { $in: ["alfred", "everhaus"] } },
  ],
};

export interface CleanupReport {
  dryRun: boolean;
  servicesDeleted: number;
  servicesSkippedReferenced: number;
  categoryDeleted: number;
  categorySkippedReferenced: number;
  plansDeleted: number;
  plansSkippedReferenced: number;
  benefitsPulledFromPlans: number;
  modifiersUpdated: number;
  bundlesUpdated: number;
  serviceOwnerUnset: number;
  planFieldsUnset: number;
}

const idsOf = async (collection: Collection, filter: mongo.Filter<mongo.Document>) =>
  (await collection.find(filter, { projection: { _id: 1 } }).toArray()).map(
    (d) => d._id as ObjectId
  );
// Stored references may be ObjectIds or (inside price snapshots) strings.
const bothForms = (ids: ObjectId[]) => [...ids, ...ids.map(String)];

async function referenced(id: ObjectId, checks: [Collection, string[]][]): Promise<boolean> {
  for (const [collection, fields] of checks) {
    const filter = { $or: fields.map((f) => ({ [f]: { $in: bothForms([id]) } })) };
    if (await collection.countDocuments(filter, { limit: 1 })) return true;
  }
  return false;
}

async function partition(ids: ObjectId[], checks: [Collection, string[]][]) {
  const keep: ObjectId[] = [];
  const remove: ObjectId[] = [];
  for (const id of ids) ((await referenced(id, checks)) ? keep : remove).push(id);
  return { keep, remove };
}

export async function cleanupEverhaus({ dryRun }: { dryRun: boolean }): Promise<CleanupReport> {
  const services = Service.collection;
  const categories = ServiceCategory.collection;
  const plans = MembershipPlan.collection;
  const modifiers = DeliveryModifier.collection;
  const appointments = Appointment.collection;
  const episodes = AssessmentEpisode.collection;
  const ledger = AllowanceLedgerEntry.collection;
  const memberships = MemberMembership.collection;

  const serviceIds = await partition(await idsOf(services, { owner: LEGACY_OWNER }), [
    [appointments, ["serviceId"]],
    [episodes, ["bundleServiceId"]],
    [ledger, ["serviceId"]],
  ]);
  const planIds = await partition(await idsOf(plans, LEGACY_PLAN_FILTER), [
    [memberships, ["planId"]],
    [appointments, ["planId", "price.selection.planId"]],
    [episodes, ["planId", "price.selection.planId"]],
    [ledger, ["planId"]],
  ]);
  const removed = { $in: serviceIds.remove };
  const benefitFilter = { "benefits.serviceId": removed, _id: { $nin: planIds.remove } };
  const category = await categories.findOne({ name: LEGACY_CATEGORY }, { projection: { _id: 1 } });
  // Services deleted in this run no longer count as references to the category.
  const categoryInUse = category
    ? (await services.countDocuments({
        categoryId: category._id,
        _id: { $nin: serviceIds.remove },
      })) > 0
    : false;
  const ownerFilter = { owner: { $exists: true, $ne: LEGACY_OWNER } };
  const planFieldFilter = {
    $and: [
      { $nor: [LEGACY_PLAN_FILTER] },
      {
        $or: [
          { brand: { $exists: true } },
          { isBaseline: { $exists: true } },
          { restrictedOwners: { $exists: true } },
        ],
      },
    ],
  };

  const report: CleanupReport = {
    dryRun,
    servicesDeleted: serviceIds.remove.length,
    servicesSkippedReferenced: serviceIds.keep.length,
    categoryDeleted: category && !categoryInUse ? 1 : 0,
    categorySkippedReferenced: category && categoryInUse ? 1 : 0,
    plansDeleted: planIds.remove.length,
    plansSkippedReferenced: planIds.keep.length,
    benefitsPulledFromPlans: await plans.countDocuments(benefitFilter),
    modifiersUpdated: await modifiers.countDocuments({ serviceIds: removed }),
    bundlesUpdated: await services.countDocuments({ bundleComponentIds: removed }),
    serviceOwnerUnset: await services.countDocuments(ownerFilter),
    planFieldsUnset: await plans.countDocuments(planFieldFilter),
  };
  if (dryRun) return report;

  await plans.updateMany(benefitFilter, { $pull: { benefits: { serviceId: removed } } } as never);
  await modifiers.updateMany({ serviceIds: removed }, { $pull: { serviceIds: removed } } as never);
  await services.updateMany({ bundleComponentIds: removed }, {
    $pull: { bundleComponentIds: removed },
  } as never);
  await services.deleteMany({ _id: removed });
  await plans.deleteMany({ _id: { $in: planIds.remove } });
  if (report.categoryDeleted && category) await categories.deleteOne({ _id: category._id });
  await services.updateMany(ownerFilter, { $unset: { owner: "" } });
  await plans.updateMany(planFieldFilter, {
    $unset: { brand: "", isBaseline: "", restrictedOwners: "" },
  });
  return report;
}
