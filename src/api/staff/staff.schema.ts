import { z } from "zod";
import { nonEmptyPatch, objectId } from "../../common/http.js";
import { emailSchema } from "../auth/auth.schema.js";
import { overrideSchema } from "../role/permission.js";
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Invalid date");
export const certificateSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    issuer: z.string().max(150).optional(),
    licenseNumber: z.string().max(100).optional(),
    expirationDate: dateOnly,
  })
  .strict();
export const personalSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: emailSchema,
    phone: z.string().max(40).optional(),
    dateOfBirth: dateOnly.optional(),
    sex: z.enum(["male", "female"]).optional(),
    address: z
      .object({
        line1: z.string().max(200).optional(),
        line2: z.string().max(200).optional(),
        city: z.string().max(100).optional(),
        state: z.string().max(100).optional(),
        postalCode: z.string().max(30).optional(),
        country: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
    isProvider: z.boolean().optional(),
  })
  .strict();
export const employmentSchema = z
  .object({
    employmentType: z.enum(["full_time", "part_time", "contract"]),
    startDate: dateOnly.optional(),
    locationId: objectId.optional(),
  })
  .strict();
export const staffCreate = personalSchema
  .extend({
    roleId: objectId,
    employmentType: employmentSchema.shape.employmentType,
    startDate: dateOnly.optional(),
    locationId: objectId.optional(),
    licenses: z.array(certificateSchema).max(20).default([]),
  })
  .strict();
export const staffPatch = nonEmptyPatch(personalSchema.omit({ email: true }).partial());
export const permissionPatch = z
  .object({
    roleId: objectId,
    employmentType: employmentSchema.shape.employmentType,
    overrides: overrideSchema,
  })
  .strict();
export const compensationSchema = z
  .object({
    payType: z.enum(["salary", "hourly"]),
    paySchedule: z.string().min(1).max(60),
    annualSalaryCents: z.number().int().nonnegative().max(100000000).optional(),
    hourlyRateCents: z.number().int().nonnegative().max(1000000).optional(),
  })
  .strict();
export const deactivateSchema = z
  .object({
    reason: z.enum(["left_org", "role_change", "security_concern", "other"]),
    notes: z.string().max(2000).optional(),
    notify: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.reason !== "other" || Boolean(v.notes?.trim()), "Notes are required for Other");
export const bulkDeactivate = z
  .object({ ids: z.array(objectId).min(1).max(100), ...deactivateSchema.innerType().shape })
  .strict()
  .refine((v) => v.reason !== "other" || Boolean(v.notes?.trim()), "Notes are required for Other");
const values = (item: z.ZodTypeAny) =>
  z.preprocess((v) => (typeof v === "string" ? [v] : v), z.array(item).max(30).optional());
export const staffQuery = z
  .object({
    q: z.string().max(100).optional(),
    roleIds: values(objectId),
    status: values(z.enum(["active", "pending_onboarding", "deactivated", "on_duty"])),
    flags: values(z.enum(["custom", "certification_renewal", "pto_requested", "open_shift"])),
    groupBy: z.literal("role").optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
