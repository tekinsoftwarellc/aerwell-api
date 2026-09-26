import { z } from "zod";
import { nonEmptyPatch, objectId } from "../../common/http.js";
import { permissionSchema } from "../role/permission.js";
const timeZone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Invalid IANA time zone");
export const profileSchema = nonEmptyPatch(
  z
    .object({
      name: z.string().trim().min(1).max(150).optional(),
      primaryLocationId: objectId.optional(),
      timeZone: timeZone.optional(),
    })
    .strict()
);
export const regionalSchema = nonEmptyPatch(
  z
    .object({
      dateFormat: z.enum(["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"]).optional(),
      measurementSystem: z.enum(["imperial", "metric"]).optional(),
      currency: z.enum(["USD", "CAD", "EUR", "GBP"]).optional(),
    })
    .strict()
);
export const securitySchema = nonEmptyPatch(
  z
    .object({
      autoSignOutMinutes: z
        .union([z.literal(5), z.literal(15), z.literal(30), z.literal(60), z.literal(120)])
        .optional(),
      requireTwoFactor: z.boolean().optional(),
    })
    .strict()
);
export const roleSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    shortCode: z.string().max(8).optional(),
    summary: z.string().max(500).optional(),
    color: z
      .string()
      .regex(/^#[a-f\d]{6}$/i)
      .optional(),
    permissions: permissionSchema,
  })
  .strict();
export const rolePatch = nonEmptyPatch(roleSchema.partial());
const channels = z.object({ in_app: z.boolean(), push: z.boolean(), email: z.boolean() }).strict();
export const preferencesSchema = z
  .object({
    matrix: z
      .object({
        billing: channels.optional(),
        approvals: channels.optional(),
        critical_alerts: channels.optional(),
        appointments: channels.optional(),
        members: channels.optional(),
        system: channels.optional(),
      })
      .strict(),
    quietHours: z
      .object({
        enabled: z.boolean(),
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      })
      .strict(),
  })
  .strict();
export const ruleSchema = z
  .object({
    trigger: z.enum([
      "critical_lab_result",
      "time_off_request",
      "result_past_turnaround",
      "failed_payment",
    ]),
    recipient: z.object({ type: z.literal("role"), id: objectId }).strict(),
    channels: z
      .array(z.enum(["in_app", "push", "email"]))
      .min(1)
      .max(3),
    enabled: z.boolean().default(true),
  })
  .strict();
export const rulePatch = nonEmptyPatch(ruleSchema.partial());
export const auditQuery = z
  .object({
    actorId: objectId.optional(),
    memberId: objectId.optional(),
    action: z.string().max(80).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    cursor: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
