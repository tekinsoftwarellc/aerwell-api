import { z } from "zod";
import {
  BASIS_POINTS_PER_WHOLE,
  BENEFIT_ACCESS,
  PERIOD_UNITS,
} from "../entitlement/entitlement.types.js";
import { cents, objectId, slug } from "../service/service.schema.js";

const unique = <T extends z.ZodTypeAny>(item: T, max: number, label: string) =>
  z
    .array(item)
    .max(max)
    .refine((v) => new Set(v).size === v.length, `${label} must be unique`)
    .default([]);
const expectedVersion = z.number().int().min(0).optional();
const nonEmptyPatch = <T extends z.ZodRawShape>(shape: z.ZodObject<T>) =>
  shape.refine(
    (v) => Object.keys(v).some((k) => k !== "expectedVersion"),
    "Supply a field to update"
  );

const marketFields = z
  .object({
    slug,
    name: z.string().trim().min(1).max(120),
    active: z.boolean().default(true),
    locationIds: unique(objectId, 50, "Locations"),
  })
  .strict();
export const marketCreateSchema = marketFields;
export const marketPatchSchema = nonEmptyPatch(
  marketFields.omit({ slug: true }).partial().extend({ expectedVersion }).strict()
);

const pricing = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("retail") }).strict(),
  z.object({ mode: z.literal("included") }).strict(),
  z
    .object({
      mode: z.literal("discount"),
      discountBps: z.number().int().min(1).max(BASIS_POINTS_PER_WHOLE),
    })
    .strict(),
  z.object({ mode: z.literal("custom"), customPriceCents: cents }).strict(),
]);
export const benefitSchema = z
  .object({
    serviceId: objectId,
    access: z.enum(BENEFIT_ACCESS),
    includedQuantity: z.number().int().min(0).max(1000).default(0),
    period: z
      .object({
        unit: z.enum(PERIOD_UNITS),
        anchor: z.literal("anniversary").default("anniversary"),
        rollover: z.literal("none").default("none"),
      })
      .strict()
      .nullable()
      .default(null),
    exhaustion: z.enum(["paid", "deny"]).default("paid"),
    pricing: pricing.default({ mode: "retail" }),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.includedQuantity > 0 && !v.period)
      c.addIssue({
        code: "custom",
        path: ["period"],
        message: "An allowance needs a reset period",
      });
    if (v.includedQuantity === 0 && v.period)
      c.addIssue({ code: "custom", path: ["period"], message: "Only allowances have a period" });
    const free =
      v.pricing.mode === "included" ||
      (v.pricing.mode === "discount" && v.pricing.discountBps === BASIS_POINTS_PER_WHOLE);
    if (v.includedQuantity > 0 && free)
      c.addIssue({
        code: "custom",
        path: ["pricing"],
        message:
          "An allowance must be followed by a charge; use Included without a quantity for unlimited",
      });
    if (v.access === "ineligible" && (v.includedQuantity > 0 || v.pricing.mode !== "retail"))
      c.addIssue({
        code: "custom",
        path: ["access"],
        message: "Ineligible benefits carry no price",
      });
  });
const planFields = z
  .object({
    slug,
    name: z.string().trim().min(1).max(120),
    priceCents: cents.nullable().default(null),
    billingTerm: z.enum(["monthly", "quarterly", "annual"]).nullable().default(null),
    status: z.enum(["active", "archived"]).default("active"),
    clinicianChat: z.boolean().default(false),
    benefits: z
      .array(benefitSchema)
      .max(100)
      .refine(
        (b) => new Set(b.map((x) => x.serviceId)).size === b.length,
        "Each service can have one benefit per plan"
      )
      .default([]),
  })
  .strict();
export const planCreateSchema = planFields;
export const planPatchSchema = nonEmptyPatch(
  planFields.omit({ slug: true }).partial().extend({ expectedVersion }).strict()
);
export type PlanInput = z.infer<typeof planCreateSchema>;

const modifierFields = z
  .object({
    slug: slug.refine((v) => v !== "standard", "standard is reserved for no modifier"),
    name: z.string().trim().min(1).max(120),
    amountCents: cents,
    serviceIds: unique(objectId, 100, "Services").refine((v) => v.length > 0, "Choose a service"),
    marketScope: z.enum(["all", "listed"]).default("all"),
    marketIds: unique(objectId, 50, "Markets"),
    chargeWhenIncluded: z.boolean().default(true),
    active: z.boolean().default(true),
  })
  .strict();
const scopeRule = (v: { marketScope?: string; marketIds?: string[] }, c: z.RefinementCtx) => {
  if (v.marketScope === "all" && v.marketIds?.length)
    c.addIssue({
      code: "custom",
      path: ["marketIds"],
      message: "Markets apply only to listed scope",
    });
};
export const modifierCreateSchema = modifierFields.superRefine(scopeRule);
export const modifierPatchSchema = nonEmptyPatch(
  modifierFields.omit({ slug: true }).partial().extend({ expectedVersion }).strict()
);

export const revisionQuerySchema = z
  .object({
    entityType: z.enum(["service", "market", "membership_plan", "delivery_modifier"]),
    entityId: objectId,
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const previewSchema = z
  .object({
    serviceId: objectId,
    marketId: objectId.nullable().default(null),
    deliveryMethod: z.string().trim().min(1).max(80).default("standard"),
    at: z.coerce.date(),
    memberships: z
      .array(z.object({ planId: objectId, startedAt: z.coerce.date() }).strict())
      .max(10)
      .refine((m) => new Set(m.map((x) => x.planId)).size === m.length, "Plans must be unique")
      .default([]),
    // Keyed "<planId>:<benefitId>" (preview membership id = plan id).
    usage: z.record(z.string().max(120), z.number().int().min(0).max(10_000)).default({}),
  })
  .strict();
