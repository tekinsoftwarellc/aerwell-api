import { Schema, model } from "mongoose";
import { BENEFIT_ACCESS, PERIOD_UNITS, PRICING_MODES } from "../entitlement/entitlement.types.js";

// Every editable catalog document uses `version` as its optimistic-concurrency
// key: mongoose adds it to the save filter and increments it on each change.
const versioned = { timestamps: true, versionKey: "version", optimisticConcurrency: true } as const;
const objectIds = (ref: string) => ({
  type: [{ type: Schema.Types.ObjectId, ref }],
  default: [],
});
const slugIndex = { unique: true, partialFilterExpression: { slug: { $type: "string" } } };

const marketSchema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    slug: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
    locationIds: objectIds("Location"),
  },
  versioned
);
marketSchema.index({ organizationId: 1, slug: 1 }, slugIndex);
export const Market = model("Market", marketSchema);

const benefitSchema = new Schema(
  {
    id: { type: String, required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", required: true },
    access: { type: String, enum: BENEFIT_ACCESS, required: true },
    includedQuantity: { type: Number, min: 0, default: 0 },
    period: {
      type: new Schema(
        {
          unit: { type: String, enum: PERIOD_UNITS, required: true },
          anchor: { type: String, enum: ["anniversary"], default: "anniversary" },
          rollover: { type: String, enum: ["none"], default: "none" },
        },
        { _id: false }
      ),
      default: null,
    },
    exhaustion: { type: String, enum: ["paid", "deny"], default: "paid" },
    pricing: {
      type: new Schema(
        {
          mode: { type: String, enum: PRICING_MODES, required: true },
          discountBps: { type: Number, min: 1, max: 10_000 },
          customPriceCents: { type: Number, min: 0 },
        },
        { _id: false }
      ),
      required: true,
    },
  },
  { _id: false }
);
const planSchema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    slug: String,
    name: { type: String, required: true, trim: true },
    priceCents: { type: Number, min: 0, default: null },
    billingTerm: { type: String, enum: ["monthly", "quarterly", "annual", null], default: null },
    status: { type: String, enum: ["active", "archived"], default: "active" },
    clinicianChat: { type: Boolean, default: false },
    benefits: { type: [benefitSchema], default: [] },
    effectiveFrom: { type: Date, default: Date.now },
  },
  versioned
);
// Partial: legacy Tier 1/2/3 plans have no slug (see catalog.migration.ts).
planSchema.index({ organizationId: 1, slug: 1 }, slugIndex);
export const MembershipPlan = model("MembershipPlan", planSchema);

const modifierSchema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    slug: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    amountCents: { type: Number, required: true, min: 0 },
    serviceIds: objectIds("Service"),
    marketScope: { type: String, enum: ["all", "listed"], default: "all" },
    marketIds: objectIds("Market"),
    chargeWhenIncluded: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
    effectiveFrom: { type: Date, default: Date.now },
  },
  versioned
);
modifierSchema.index({ organizationId: 1, slug: 1 }, slugIndex);
export const DeliveryModifier = model("DeliveryModifier", modifierSchema);

const revisionSchema = new Schema(
  {
    organizationId: { type: String, required: true },
    entityType: {
      type: String,
      enum: ["service", "market", "membership_plan", "delivery_modifier"],
      required: true,
    },
    entityId: { type: String, required: true },
    version: { type: Number, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
    actorId: { type: String, required: true },
    effectiveFrom: { type: Date, required: true },
    recordedAt: { type: Date, default: Date.now, immutable: true },
  },
  { versionKey: false }
);
revisionSchema.index({ organizationId: 1, entityType: 1, entityId: 1, version: -1 });
for (const operation of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const)
  revisionSchema.pre(operation, () => {
    throw new Error("Catalog revisions are append-only");
  });
export const CatalogRevision = model("CatalogRevision", revisionSchema);
