import type { Request } from "express";
import type { Document } from "mongoose";
import { BadRequestError, ConflictError, NotFoundError } from "../../common/errors/AppError.js";
import { evaluateEntitlement } from "../entitlement/evaluate.js";
import { loadCatalogSnapshot } from "../entitlement/snapshot.js";
import { Location } from "../location/location.model.js";
import { Service } from "../service/service.model.js";
import { objectId } from "../service/service.schema.js";
import { CatalogRevision, DeliveryModifier, Market, MembershipPlan } from "./catalog.model.js";
import {
  type PlanInput,
  marketCreateSchema,
  marketPatchSchema,
  modifierCreateSchema,
  modifierPatchSchema,
  planCreateSchema,
  planPatchSchema,
  previewSchema,
  revisionQuerySchema,
} from "./catalog.schema.js";
import { type CatalogEntity, assertExpectedVersion, saveVersioned } from "./versioning.js";

const orgOf = (req: Request) => req.staff?.organizationId ?? "";
function serialize(doc: Document) {
  const { _id, organizationId, __v, ...value } = doc.toObject({ depopulate: true });
  return { ...value, id: String(_id) };
}
function ownedFilter(req: Request) {
  return { _id: objectId.parse(req.params["id"]), organizationId: orgOf(req) };
}
function must<T>(doc: T, label: string): NonNullable<T> {
  if (!doc) throw new NotFoundError(`${label} not found`);
  return doc as NonNullable<T>;
}
async function assertSlugFree(
  model: { exists: (f: object) => PromiseLike<unknown> },
  organizationId: string,
  slug: string
) {
  if (await model.exists({ organizationId, slug }))
    throw new ConflictError("Another record already uses this identifier", undefined, "SLUG_TAKEN");
}
async function assertAll(
  model: { countDocuments: (f: object) => PromiseLike<number> },
  filter: object,
  expected: number,
  message: string
) {
  if ((await model.countDocuments(filter)) !== expected) throw new BadRequestError(message);
}
async function create(
  req: Request,
  entity: CatalogEntity,
  model: { exists: (f: object) => PromiseLike<unknown>; new (v: object): Document },
  input: { slug: string }
) {
  await assertSlugFree(model, orgOf(req), input.slug);
  const doc = new model({ ...input, organizationId: orgOf(req) });
  await saveVersioned(req, entity, doc, "created");
  return serialize(doc);
}

// Markets ------------------------------------------------------------------
async function validateLocations(req: Request, locationIds: string[] = []) {
  await assertAll(
    Location,
    { _id: { $in: locationIds }, organizationId: orgOf(req) },
    locationIds.length,
    "Select locations from this organization"
  );
}
export async function listMarkets(req: Request) {
  return (await Market.find({ organizationId: orgOf(req) }).sort({ name: 1 })).map(serialize);
}
export async function createMarket(req: Request) {
  const input = marketCreateSchema.parse(req.body);
  await validateLocations(req, input.locationIds);
  return create(req, "market", Market, input);
}
export async function patchMarket(req: Request) {
  const { expectedVersion, ...patch } = marketPatchSchema.parse(req.body);
  const doc = must(await Market.findOne(ownedFilter(req)), "Market");
  assertExpectedVersion(doc, expectedVersion);
  await validateLocations(req, patch.locationIds);
  doc.set(patch);
  await saveVersioned(req, "market", doc, "updated");
  return serialize(doc);
}

// Membership plans ---------------------------------------------------------
type BenefitInput = PlanInput["benefits"][number];
type ServiceFacts = { basePriceCents?: number | null; owner?: string | null };
type PlanFacts = { isBaseline: boolean; restrictedOwners: string[] };
function benefitRule(benefit: BenefitInput, service: ServiceFacts, plan: PlanFacts) {
  const retail = service.basePriceCents;
  const baseline = plan.isBaseline;
  // The baseline is every member (Free/DTC): it may never open a restricted owner.
  if (
    baseline &&
    benefit.access !== "ineligible" &&
    plan.restrictedOwners.includes(String(service.owner))
  )
    return "The baseline entitlement cannot grant services of a restricted owner";
  if (benefit.access === "exclusive" && retail != null)
    return "Exclusive access is only for services without a retail price";
  if (benefit.pricing.mode === "discount" && retail == null)
    return "A discount needs a service with a retail price";
  if (baseline && benefit.includedQuantity > 0)
    return "The baseline entitlement cannot carry allowances";
  return null;
}
async function validatePlan(req: Request, input: PlanInput, selfId?: string) {
  const organizationId = orgOf(req);
  const services = await Service.find({
    _id: { $in: input.benefits.map((b) => b.serviceId) },
    organizationId,
    deletedAt: null,
  }).select("basePriceCents owner");
  if (services.length !== input.benefits.length)
    throw new BadRequestError("Every benefit must reference an active catalog service");
  for (const benefit of input.benefits) {
    const service = services.find((s) => String(s._id) === benefit.serviceId);
    const problem = benefitRule(benefit, service ?? {}, input);
    if (problem) throw new BadRequestError(problem);
  }
  if (
    input.isBaseline &&
    input.status === "active" &&
    (await MembershipPlan.exists({
      organizationId,
      isBaseline: true,
      status: "active",
      ...(selfId ? { _id: { $ne: selfId } } : {}),
    }))
  )
    throw new ConflictError(
      "Only one active baseline entitlement is allowed",
      undefined,
      "BASELINE_EXISTS"
    );
}
const withBenefitIds = (input: Partial<PlanInput>) =>
  input.benefits
    ? { ...input, benefits: input.benefits.map((b) => ({ ...b, id: b.serviceId })) }
    : input;
export async function listPlans(req: Request) {
  return (
    await MembershipPlan.find({ organizationId: orgOf(req), slug: { $type: "string" } }).sort({
      isBaseline: -1,
      name: 1,
    })
  ).map(serialize);
}
export async function getPlan(req: Request) {
  return serialize(must(await MembershipPlan.findOne(ownedFilter(req)), "Membership plan"));
}
export async function createPlan(req: Request) {
  const input = planCreateSchema.parse(req.body);
  await validatePlan(req, input);
  return create(req, "membership_plan", MembershipPlan, withBenefitIds(input) as PlanInput);
}
function editablePlan(doc: InstanceType<typeof MembershipPlan>) {
  const { slug, ...value } = serialize(doc) as PlanInput & Record<string, unknown>;
  return planCreateSchema.omit({ slug: true }).parse({
    name: value.name,
    brand: value.brand,
    priceCents: value.priceCents ?? null,
    billingTerm: value.billingTerm ?? null,
    status: value.status,
    isBaseline: value.isBaseline,
    clinicianChat: value.clinicianChat,
    restrictedOwners: value.restrictedOwners,
    benefits: (value.benefits ?? []).map(({ id, ...b }: BenefitInput & { id?: string }) => ({
      ...b,
      serviceId: String(b.serviceId),
    })),
  });
}
export async function patchPlan(req: Request) {
  const { expectedVersion, ...patch } = planPatchSchema.parse(req.body);
  const doc = must(await MembershipPlan.findOne(ownedFilter(req)), "Membership plan");
  if (!doc.slug) throw new BadRequestError("Legacy tier plans are read-only; create a new plan");
  assertExpectedVersion(doc, expectedVersion);
  const merged = { ...editablePlan(doc), ...patch, slug: doc.slug };
  if (
    doc.isBaseline &&
    doc.status === "active" &&
    !(merged.isBaseline && merged.status === "active")
  )
    throw new ConflictError(
      "Every organization needs an active baseline entitlement; edit it instead",
      undefined,
      "BASELINE_REQUIRED"
    );
  await validatePlan(req, merged, String(doc._id));
  doc.set({ ...withBenefitIds(patch), effectiveFrom: new Date() });
  await saveVersioned(req, "membership_plan", doc, "updated");
  return serialize(doc);
}

/** A service retail change must keep every plan benefit on it valid. */
export async function assertRetailFitsPlans(
  organizationId: string,
  service: { _id: unknown; owner?: string | null },
  retail: number | null
) {
  const plans = await MembershipPlan.find({
    organizationId,
    slug: { $type: "string" },
    "benefits.serviceId": service._id,
  });
  const broken = plans.filter((plan) =>
    plan.benefits.some(
      (b) =>
        String(b.serviceId) === String(service._id) &&
        benefitRule(
          b as unknown as BenefitInput,
          { basePriceCents: retail, owner: service.owner },
          plan
        )
    )
  );
  if (broken.length)
    throw new BadRequestError(
      `This retail change conflicts with benefits in ${broken.map((p) => p.name).join(", ")}. Update those plans first.`
    );
}

// Delivery modifiers -------------------------------------------------------
async function validateModifierLinks(req: Request, serviceIds?: string[], marketIds?: string[]) {
  const organizationId = orgOf(req);
  if (serviceIds)
    await assertAll(
      Service,
      { _id: { $in: serviceIds }, organizationId, deletedAt: null },
      serviceIds.length,
      "Select services from this organization's catalog"
    );
  if (marketIds)
    await assertAll(
      Market,
      { _id: { $in: marketIds }, organizationId },
      marketIds.length,
      "Select markets from this organization"
    );
}
export async function listModifiers(req: Request) {
  return (await DeliveryModifier.find({ organizationId: orgOf(req) }).sort({ name: 1 })).map(
    serialize
  );
}
export async function createModifier(req: Request) {
  const input = modifierCreateSchema.parse(req.body);
  await validateModifierLinks(req, input.serviceIds, input.marketIds);
  return create(req, "delivery_modifier", DeliveryModifier, input);
}
export async function patchModifier(req: Request) {
  const { expectedVersion, ...patch } = modifierPatchSchema.parse(req.body);
  const doc = must(await DeliveryModifier.findOne(ownedFilter(req)), "Delivery modifier");
  assertExpectedVersion(doc, expectedVersion);
  const scope = patch.marketScope ?? doc.marketScope;
  const markets = patch.marketIds ?? doc.marketIds.map(String);
  if (scope === "all" && markets.length)
    throw new BadRequestError("Markets apply only to listed scope");
  await validateModifierLinks(req, patch.serviceIds, patch.marketIds);
  doc.set({ ...patch, effectiveFrom: new Date() });
  await saveVersioned(req, "delivery_modifier", doc, "updated");
  return serialize(doc);
}

// History and preview ------------------------------------------------------
export async function listRevisions(req: Request) {
  const q = revisionQuerySchema.parse(req.query);
  const filter = { organizationId: orgOf(req), entityType: q.entityType, entityId: q.entityId };
  const [docs, total] = await Promise.all([
    CatalogRevision.find(filter)
      .sort({ version: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    CatalogRevision.countDocuments(filter),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / q.limit));
  return {
    items: docs.map(({ _id, organizationId, ...v }) => ({ ...v, id: String(_id) })),
    pagination: {
      page: q.page,
      limit: q.limit,
      total,
      totalPages,
      hasNext: q.page < totalPages,
      hasPrev: q.page > 1,
    },
  };
}
/** Staff what-if quote: hypothetical memberships, no member record, no ledger. */
export async function previewEntitlement(req: Request) {
  const input = previewSchema.parse(req.body);
  const catalog = await loadCatalogSnapshot(orgOf(req));
  return evaluateEntitlement(catalog, {
    serviceId: input.serviceId,
    marketId: input.marketId,
    deliveryMethod: input.deliveryMethod,
    at: input.at,
    now: new Date(),
    memberships: input.memberships.map((m) => ({
      id: m.planId,
      planId: m.planId,
      status: "active",
      startedAt: m.startedAt,
    })),
    usage: input.usage,
  });
}
