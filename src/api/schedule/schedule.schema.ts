import { z } from "zod";
import { nonEmptyPatch, objectId, queryArray } from "../../common/http.js";
export const PTO_TYPES = ["vacation", "sick", "personal", "other"] as const;
export const PTO_STATUSES = ["pending", "approved", "denied"] as const;
export const ONBOARDING_STEPS = ["paperwork", "training"] as const;
export const date = z
  .string()
  .regex(/^20\d\d-\d\d-\d\d$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
    "Invalid date"
  );
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:mm");
const fields = z
  .object({
    staffId: objectId.nullable().optional(),
    date,
    startTime: time,
    endTime: time,
    positionRoleId: objectId,
    locationId: objectId,
    stationName: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const endAfterStart = { message: "End must follow start on the same day", path: ["endTime"] };
export const shiftBody = fields.refine((v) => v.startTime < v.endTime, endAfterStart);
export const shiftPatch = nonEmptyPatch(fields.partial());
export type ShiftInput = z.infer<typeof shiftBody>;
export const scheduleQuery = z
  .object({
    date,
    view: z.enum(["day", "week", "month"]).default("day"),
    staffId: objectId.optional(),
    roleIds: queryArray(objectId),
    q: z.string().trim().max(100).optional(),
  })
  .strict();
export type ScheduleQuery = z.infer<typeof scheduleQuery>;
export const overviewQuery = z.object({ date: date.optional() }).strict();
export const dateQuery = z.object({ date }).strict();
export const monthQuery = z
  .object({ month: z.string().regex(/^20\d\d-(0[1-9]|1[0-2])$/) })
  .strict();
export const yearQuery = z
  .object({ year: z.coerce.number().int().min(2000).max(2099).optional() })
  .strict();
export const ptoListQuery = z.object({ status: z.enum(PTO_STATUSES).optional() }).strict();
export const ptoBody = z
  .object({
    startDate: date,
    endDate: date,
    type: z.enum(PTO_TYPES),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.endDate >= v.startDate && Date.parse(v.endDate) - Date.parse(v.startDate) < 366 * 86400000,
    { message: "Time off must span 1–366 days", path: ["endDate"] }
  );
export const decisionBody = z.object({ reason: z.string().trim().max(1000).optional() }).strict();
const availabilityDay = z
  .object({
    weekday: z.number().int().min(0).max(6),
    available: z.boolean(),
    start: time.optional(),
    end: time.optional(),
  })
  .strict()
  .refine((v) => !v.available || Boolean(v.start && v.end && v.start < v.end), {
    message: "Available days need a start before the end",
    path: ["end"],
  });
export const availabilityBody = z
  .object({
    days: z
      .array(availabilityDay)
      .length(7)
      .refine((v) => new Set(v.map((d) => d.weekday)).size === 7, "Each weekday must appear once"),
  })
  .strict();
export const onboardingBody = z
  .object({
    steps: z
      .array(z.object({ key: z.enum(ONBOARDING_STEPS), complete: z.boolean() }).strict())
      .length(ONBOARDING_STEPS.length)
      .refine(
        (v) => new Set(v.map((s) => s.key)).size === ONBOARDING_STEPS.length,
        "Each step must appear once"
      ),
  })
  .strict();
