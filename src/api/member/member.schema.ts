import { z } from "zod";
import { nonEmptyPatch, objectId, queryArray } from "../../common/http.js";
import { emailSchema } from "../auth/auth.schema.js";
import { dateOnly } from "../staff/staff.schema.js";
import { FLAG_CATEGORIES, MEMBER_STATUSES, VIEW_CARDS, VIEW_CONTEXTS } from "./member.model.js";

const text = (max: number) => z.string().trim().max(max);
export const addressSchema = z
  .object({
    line1: text(200).optional(),
    line2: text(200).optional(),
    city: text(100).optional(),
    state: text(100).optional(),
    postalCode: text(30).optional(),
    country: text(100).optional(),
  })
  .strict();
const personal = {
  firstName: text(100).min(1),
  lastName: text(100).min(1),
  email: emailSchema,
  phone: text(40).optional(),
  dateOfBirth: dateOnly.optional(),
  sex: z.enum(["male", "female"]).optional(),
  address: addressSchema.optional(),
  emergencyContact: z
    .object({ name: text(200), phone: text(40) })
    .strict()
    .optional(),
  homeLocationId: objectId.optional(),
  assignedClinicianIds: z.array(objectId).max(20).optional(),
  photoUploadId: objectId.optional(),
};
export const memberCreate = z
  .object({
    ...personal,
    intakeNote: text(4000).optional(),
    memberships: z
      .array(z.object({ planId: objectId, startedAt: z.coerce.date().optional() }).strict())
      .max(5)
      .default([]),
  })
  .strict();
export const memberPatch = nonEmptyPatch(
  z
    .object({ ...personal, status: z.enum(MEMBER_STATUSES) })
    .partial()
    .strict()
);
export const MEMBER_SORTS = ["lastName", "-lastName", "lastVisitAt", "-lastVisitAt", "-createdAt"];
export const LIST_FLAG_FILTERS = [
  "on_waitlist",
  "outstanding_balance",
  "flagged_for_review",
] as const;
export const memberQuery = z
  .object({
    q: text(100).optional(),
    status: queryArray(z.enum(MEMBER_STATUSES)),
    flags: queryArray(z.enum(LIST_FLAG_FILTERS)),
    sort: z.enum(MEMBER_SORTS as [string, ...string[]]).default("lastName"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type MemberQuery = z.infer<typeof memberQuery>;
export const searchQuery = z.object({ q: text(100).min(1) }).strict();
export const bulkArchive = z.object({ ids: z.array(objectId).min(1).max(100) }).strict();
export const flagCreate = z
  .object({
    category: z.enum(FLAG_CATEGORIES),
    title: text(200).min(1),
    description: text(1000).optional(),
    severity: z.enum(["urgent", "open"]).default("open"),
    relatedServiceId: objectId.optional(),
  })
  .strict();
export const flagQuery = z
  .object({ state: z.enum(["active", "resolved", "all"]).default("active") })
  .strict();
export const noteCreate = z
  .object({
    body: text(8000).min(1),
    appointmentId: objectId.optional(),
    recordingOffsetSec: z.number().int().min(0).max(86_400).optional(),
  })
  .strict();
export const notesRead = z.object({ noteIds: z.array(objectId).max(200).optional() }).strict();
export const viewParams = z.object({ context: z.enum(VIEW_CONTEXTS) }).strict();
export const viewPut = z
  .object({
    layout: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    columns: z.array(z.array(z.enum(VIEW_CARDS)).max(VIEW_CARDS.length)),
  })
  .strict()
  .refine((v) => v.columns.length === v.layout, {
    path: ["columns"],
    message: "Provide exactly one column list per layout column",
  })
  .refine((v) => new Set(v.columns.flat()).size === v.columns.flat().length, {
    path: ["columns"],
    message: "A card can appear in only one column",
  });
export const membershipCreate = z
  .object({
    planId: objectId,
    startedAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    autoRenew: z.boolean().default(true),
  })
  .strict()
  .refine((v) => !v.endsAt || !v.startedAt || v.endsAt > v.startedAt, {
    path: ["endsAt"],
    message: "End must be after start",
  });
export const membershipPatch = z
  .object({
    status: z.enum(["active", "paused", "cancelled"]),
    endsAt: z.coerce.date().nullable(),
    autoRenew: z.boolean(),
    expectedVersion: z.number().int().min(0),
  })
  .partial()
  .strict()
  .refine(
    (v) => Object.keys(v).some((key) => key !== "expectedVersion"),
    "Provide at least one field"
  );
export const benefitsQuery = z.object({ at: z.coerce.date().optional() }).strict();
export const membershipParams = z.object({ id: objectId, membershipId: objectId }).strict();
export const flagParams = z.object({ id: objectId, flagId: objectId }).strict();
