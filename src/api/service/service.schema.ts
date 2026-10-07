import { z } from "zod";
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Choose a valid record");
export const cents = z.number().int().min(0).max(100_000_000);
export const slug = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "Use lowercase letters, numbers and single dashes");
const uniqueIds = (max: number, label: string) =>
  z
    .array(objectId)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, `${label} must be unique`)
    .default([]);
const serviceObject = z
  .object({
    title: z.string().trim().min(1).max(160),
    shortName: z.string().trim().max(50).optional(),
    description: z.string().trim().max(3000).default(""),
    status: z.enum(["active", "inactive"]).default("active"),
    slug: slug.optional(),
    modality: z.enum(["physical", "virtual"]).default("physical"),
    fulfilment: z.enum(["standard", "clinical"]).default("standard"),
    marketScope: z.enum(["all", "listed"]).default("listed"),
    marketIds: uniqueIds(50, "Markets"),
    bundleComponentIds: uniqueIds(20, "Bundle components"),
    categoryId: objectId,
    locationId: objectId.nullable().default(null),
    environmentId: objectId.nullable().default(null),
    durationMinutes: z.number().int().min(1).max(1440),
    capacityMin: z.number().int().min(1).max(1000),
    capacityMax: z.number().int().min(1).max(1000),
    basePriceCents: cents.nullable(),
    lateCancellationFee: z
      .object({
        enabled: z.boolean(),
        amountCents: cents.optional(),
        windowHours: z.number().int().min(1).max(720).default(24),
      })
      .strict()
      .default({ enabled: false, windowHours: 24 }),
    assignedStaffIds: z.array(objectId).max(100).default([]),
    assignedTeamRoleId: objectId.nullable().optional(),
    imageUploadId: objectId.optional(),
    removeImage: z.boolean().optional(),
  })
  .strict();
export const serviceCreateSchema = serviceObject.superRefine((v, c) => {
  if (v.capacityMin > v.capacityMax)
    c.addIssue({
      code: "custom",
      path: ["capacityMin"],
      message: "Minimum capacity cannot exceed maximum",
    });
  if (
    v.lateCancellationFee.enabled &&
    !(v.lateCancellationFee.amountCents && v.lateCancellationFee.amountCents > 0)
  )
    c.addIssue({
      code: "custom",
      path: ["lateCancellationFee", "amountCents"],
      message: "Enabled fee requires a positive amount",
    });
  if (new Set(v.assignedStaffIds).size !== v.assignedStaffIds.length)
    c.addIssue({
      code: "custom",
      path: ["assignedStaffIds"],
      message: "Staff assignments must be unique",
    });
  if (v.environmentId && !v.locationId)
    c.addIssue({
      code: "custom",
      path: ["environmentId"],
      message: "Choose a location for this environment",
    });
  if (v.marketScope === "all" && v.marketIds.length)
    c.addIssue({
      code: "custom",
      path: ["marketIds"],
      message: "Markets apply only to listed availability",
    });
  if (v.removeImage && v.imageUploadId)
    c.addIssue({
      code: "custom",
      path: ["imageUploadId"],
      message: "Choose an image or remove it",
    });
});
// slug is a stable identifier: set once at creation, never patched.
export const servicePatchSchema = serviceObject
  .omit({ slug: true })
  .partial()
  .extend({ expectedVersion: z.number().int().min(0).optional() })
  .refine((v) => Object.keys(v).length > 0, "Supply a field to update");
export type ServiceInput = z.infer<typeof serviceCreateSchema>;
export const listSchema = z
  .object({
    q: z.string().trim().max(160).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    categoryId: objectId.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export const bulkSchema = z
  .object({
    ids: z
      .array(objectId)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, "Select unique services"),
    action: z.enum(["activate", "deactivate", "archive"]),
  })
  .strict();
export const imageSchema = z
  .object({
    contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    size: z
      .number()
      .int()
      .min(1)
      .max(5 * 1024 * 1024),
  })
  .strict();
