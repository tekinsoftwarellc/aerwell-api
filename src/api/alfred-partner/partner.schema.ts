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
