import { z } from "zod";
import { dateOnly } from "../staff/staff.schema.js";

/** Alfred's account id: 24-hex (contract §1.2). */
export const accountId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid account id");
const ref = z.string().trim().min(1).max(200);
const instant = z.string().datetime({ message: "Expected an ISO 8601 UTC timestamp" });

export const provisionBody = z
  .object({
    accountId,
    profile: z
      .object({
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().max(100).optional(),
        dateOfBirth: dateOnly.optional(),
        gender: z.string().trim().max(40).optional(),
      })
      .strict(),
    baseLocationRef: ref.optional(),
    // Read and ignored: Aerwell declares no `memberships` capability (contract §5.1).
    membership: z
      .object({
        tierKey: z.string().max(100),
        status: z.enum(["active", "suspended", "cancelled"]),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

const pull = {
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  updatedSince: instant.optional(),
  accountId: accountId.optional(),
};
export const catalogQuery = z
  .object({ ...pull, kind: z.enum(["services", "trainings", "classes", "products"]).optional() })
  .strict();
export const catalogItemParams = z.object({ partnerRef: ref }).strict();
export const catalogItemQuery = z.object({ accountId: accountId.optional() }).strict();

export const availabilityQuery = z
  .object({
    itemRef: ref,
    from: instant,
    to: instant,
    accountId,
    locationRef: ref.optional(),
    staffRef: ref.optional(),
  })
  .strict();

const money = z.number().int().min(0).max(100_000_000);
const deliveryMethod = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Invalid delivery method");
const address = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(120),
    region: z.string().trim().min(1).max(120),
    postalCode: z.string().trim().min(1).max(32),
    country: z.string().trim().min(1).max(2),
  })
  .strict();
/** Alfred's pricing outcome for a booking it priced itself (D1 addendum). Recorded, never recomputed. */
const entitlement = z
  .object({ decision: z.string().max(60), quoteRuleVersion: z.string().max(500) })
  .optional();

/**
 * Unknown top-level keys are IGNORED, not rejected: Alfred may add optional fields inside v1
 * (contract §0), and a strict body would turn that into a refused booking and a refund.
 */
export const bookingBody = z
  .object({
    accountId,
    itemRef: ref,
    slotRef: z.string().min(1).max(500),
    locationRef: ref,
    staffRef: ref.optional(),
    payment: z
      .object({
        status: z.enum(["none", "paid"]),
        paymentIntentId: z.string().min(1).max(200).optional(),
        amountCents: money,
        currency: z.string().regex(/^[a-z]{3}$/),
      })
      .superRefine((p, ctx) => {
        if (p.status === "paid" && !p.paymentIntentId)
          ctx.addIssue({
            code: "custom",
            path: ["paymentIntentId"],
            message: "Required when paid",
          });
        if (p.status === "none" && p.paymentIntentId)
          ctx.addIssue({
            code: "custom",
            path: ["paymentIntentId"],
            message: "Absent unless paid",
          });
      }),
    acceptedTermsVersion: z.string().min(1).max(64),
    notes: z.string().trim().max(2000).optional(),
    entitlement,
    deliveryMethod: deliveryMethod.optional(),
    serviceAddress: address.optional(),
    episode: z
      .object({ ref: z.string().min(1).max(100), bundleRef: z.string().min(1).max(200) })
      .optional(),
    alfredOrderRef: z.string().min(1).max(64).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.serviceAddress && (!b.deliveryMethod || b.deliveryMethod === "standard"))
      ctx.addIssue({
        code: "custom",
        path: ["serviceAddress"],
        message: "Only for a non-standard delivery method",
      });
  });
/**
 * Contract §5.10. Unknown top-level keys are ignored, like the booking body. The address never leaves
 * this body: it is stored on the order and read back by nothing but staff fulfilment.
 */
const orderAddress = address.extend({
  // Alfred sends the profile's country as typed: anything but the US is answered 409, not 400.
  country: z.string().trim().min(1).max(60),
});
export const orderBody = z.object({
  accountId,
  items: z
    .array(z.object({ itemRef: ref, quantity: z.number().int().min(1).max(99) }))
    .min(1)
    .max(20),
  shippingAddress: orderAddress,
  payment: z.object({
    status: z.enum(["none", "paid"]),
    paymentIntentId: z.string().min(1).max(200).optional(),
    amountCents: money,
    currency: z.string().regex(/^[a-z]{3}$/),
  }),
  acceptedTermsVersion: z.string().min(1).max(64),
  alfredOrderRef: z.string().min(1).max(64).optional(),
});
export const orderParams = z.object({ orderRef: z.string().min(1).max(64) }).strict();
export const bookingParams = z.object({ bookingRef: z.string().min(1).max(64) }).strict();
export const rescheduleBody = z.object({ slotRef: z.string().min(1).max(500), entitlement });
export const cancelBody = z.object({ reason: z.string().trim().max(500).optional() });
export const anyBody = z.object({});
export const reportParams = z.object({ reportRef: ref }).strict();
/** Alfred sends `?accountId` on both report routes; when present it must be the acting member. */
export const reportQuery = z.object({ accountId: accountId.optional() }).strict();

export const ordersQuery = z
  .object({
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    updatedSince: instant.optional(),
    accountId: accountId.optional(),
    kind: z.enum(["booking", "enrollment", "training_session", "purchase", "clinical"]).optional(),
  })
  .strict();

export const eventBody = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    type: z.enum(["member.provisioned", "member.deleted", "order.paid", "order.refunded"]),
    occurredAt: instant,
    accountId: accountId.optional(),
    resource: z.object({ kind: z.string().min(1).max(40), ref: z.string().min(1).max(200) }),
    payload: z.record(z.unknown()),
  })
  .strict();
