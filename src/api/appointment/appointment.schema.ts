import { z } from "zod";
import { idParams, objectId, queryArray } from "../../common/http.js";
import { dateOnly } from "../staff/staff.schema.js";
import { APPOINTMENT_STATUSES, BOOKING_SOURCES, VISIT_REASONS } from "./appointment.model.js";

const text = (max: number) => z.string().trim().max(max);
const instant = z.coerce.date();
const deliveryMethod = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "Invalid delivery method")
  .default("standard");
const expectedQuote = z
  .object({ finalCents: z.number().int().min(0).nullable(), ruleVersion: text(500) })
  .strict()
  .optional();
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, "Invalid idempotency key");

export const quoteBody = z
  .object({
    memberId: objectId,
    serviceId: objectId,
    locationId: objectId,
    startAt: instant,
    deliveryMethod,
    episodeId: objectId.optional(),
    appointmentId: objectId.optional(),
  })
  .strict();
export const bookBody = z
  .object({
    memberId: objectId,
    serviceId: objectId,
    providerId: objectId,
    locationId: objectId,
    startAt: instant,
    deliveryMethod,
    episodeId: objectId.optional(),
    reason: z.enum(VISIT_REASONS).optional(),
    reasonDetail: text(1000).optional(),
    memberNote: text(2000).optional(),
    bookingSource: z.enum(BOOKING_SOURCES).default("staff"),
    idempotencyKey: idempotencyKey.optional(),
    expectedQuote,
  })
  .strict();
export const rescheduleBody = z
  .object({
    startAt: instant,
    providerId: objectId.optional(),
    deliveryMethod: deliveryMethod.optional(),
    expectedQuote,
  })
  .strict();
export const cancelBody = z
  .object({ reason: text(500).min(1), waiveFee: z.boolean().optional() })
  .strict();
export const statusBody = z
  .object({ status: z.enum(["confirmed", "checked_in", "in_progress", "completed", "no_show"]) })
  .strict();
const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(200),
};
const filters = {
  categoryId: queryArray(objectId),
  serviceId: objectId.optional(),
  providerId: objectId.optional(),
  locationId: objectId.optional(),
  memberId: objectId.optional(),
  status: queryArray(z.enum(APPOINTMENT_STATUSES)),
  q: text(100).optional(),
};
export const listQuery = z.object({ from: dateOnly, to: dateOnly, ...filters, ...page }).strict();
export const summaryQuery = z
  .object({
    from: dateOnly.optional(),
    to: dateOnly.optional(),
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    ...filters,
  })
  .strict()
  .refine((q) => Boolean(q.month) !== Boolean(q.from && q.to), {
    message: "Provide month, or from and to",
    path: ["month"],
  });
export const availabilityQuery = z
  .object({
    serviceId: objectId,
    locationId: objectId,
    providerId: objectId.optional(),
    from: dateOnly,
    to: dateOnly.optional(),
    excludeAppointmentId: objectId.optional(),
  })
  .strict();
export const memberAppointmentsQuery = z
  .object({
    scope: z.enum(["upcoming", "past", "all"]).default("upcoming"),
    q: text(100).optional(),
    page: page.page,
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export const episodeBody = z
  .object({
    memberId: objectId,
    bundleServiceId: objectId,
    locationId: objectId,
    idempotencyKey: idempotencyKey.optional(),
    expectedQuote,
  })
  .strict();
export const episodeCancelBody = z.object({ reason: text(500).min(1) }).strict();
export { idParams };
