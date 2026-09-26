import { type HydratedDocument, type InferSchemaType, Schema, model } from "mongoose";

export const APPOINTMENT_STATUSES = [
  "booked",
  "confirmed",
  "checked_in",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
/** Statuses that occupy a slot and count as scheduled. */
export const LIVE_STATUSES: AppointmentStatus[] = [
  "booked",
  "confirmed",
  "checked_in",
  "in_progress",
  "completed",
];
export const UPCOMING_STATUSES: AppointmentStatus[] = ["booked", "confirmed", "checked_in"];
export const BOOKING_SOURCES = ["staff", "alfred_app", "phone"] as const;
export const VISIT_REASONS = [
  "new_concern",
  "assessment",
  "wellness_check",
  "medication_refill",
  "other",
] as const;
const org = { type: String, required: true, index: true };
const ref = (name: string) => ({ type: Schema.Types.ObjectId, ref: name, required: true });
const optionalRef = (name: string) => ({ type: Schema.Types.ObjectId, ref: name, default: null });

// Frozen server quote (EntitlementQuote minus candidates). Later catalog edits
// never touch it; only reschedule (an explicit re-quote) replaces it.
const priceSnapshot = { type: Schema.Types.Mixed, required: true };

const appointmentSchema = new Schema(
  {
    organizationId: org,
    memberId: ref("Member"),
    serviceId: ref("Service"),
    categoryId: ref("ServiceCategory"),
    providerId: ref("StaffMember"),
    locationId: ref("Location"),
    marketId: optionalRef("Market"),
    episodeId: optionalRef("AssessmentEpisode"),
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    durationMinutes: { type: Number, required: true, min: 1 },
    timeZone: { type: String, required: true },
    status: { type: String, enum: APPOINTMENT_STATUSES, default: "booked" },
    deliveryMethod: { type: String, default: "standard" },
    modality: { type: String, enum: ["physical", "virtual"], required: true },
    reason: { type: String, enum: VISIT_REASONS },
    reasonDetail: String,
    memberNote: String,
    bookingSource: { type: String, enum: BOOKING_SOURCES, default: "staff" },
    bookedAt: { type: Date, default: Date.now },
    bookedById: Schema.Types.ObjectId,
    idempotencyKey: String,
    price: priceSnapshot,
    // Payments are unconfigured: an amount due is recorded, nothing is captured.
    amountDueCents: { type: Number, required: true, min: 0 },
    paymentStatus: {
      type: String,
      enum: ["not_required", "unconfigured"],
      required: true,
    },
    cancellation: {
      type: new Schema(
        {
          at: Date,
          byId: Schema.Types.ObjectId,
          reason: String,
          late: Boolean,
          feeCents: Number,
          feeWaived: Boolean,
          allowance: { type: String, enum: ["released", "forfeited", "none"] },
        },
        { _id: false }
      ),
      default: null,
    },
    statusHistory: {
      type: [
        new Schema(
          { status: String, at: Date, byId: Schema.Types.ObjectId },
          { _id: false, versionKey: false }
        ),
      ],
      default: [],
    },
    // Visit flow (W9): set when the visit starts (checked_in -> in_progress).
    // Consent, transcript and suggestions live in their own collections (api/visit).
    visit: {
      type: new Schema(
        {
          startedAt: Date,
          endedAt: Date,
          recordingConsentAt: Date,
          transcriptId: String,
          summary: String,
          suggestionsRequestedAt: Date,
        },
        { _id: false }
      ),
      default: null,
    },
  },
  { timestamps: true }
);
appointmentSchema.index({ organizationId: 1, startAt: 1 });
appointmentSchema.index({ organizationId: 1, providerId: 1, startAt: 1, endAt: 1 });
appointmentSchema.index({ organizationId: 1, memberId: 1, startAt: -1 });
appointmentSchema.index({ organizationId: 1, serviceId: 1, status: 1, startAt: 1 });
appointmentSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);
export type AppointmentData = InferSchemaType<typeof appointmentSchema>;
export type AppointmentDocument = HydratedDocument<AppointmentData>;
export const Appointment = model("Appointment", appointmentSchema);

// One Advanced Assessment = one episode = at most one allowance reservation,
// shared by its separately scheduled components.
const episodeSchema = new Schema(
  {
    organizationId: org,
    memberId: ref("Member"),
    bundleServiceId: ref("Service"),
    locationId: ref("Location"),
    marketId: optionalRef("Market"),
    membershipId: optionalRef("MemberMembership"),
    benefitId: { type: String, default: null },
    status: { type: String, enum: ["open", "completed", "cancelled"], default: "open" },
    componentServiceIds: { type: [Schema.Types.ObjectId], default: [] },
    fulfilledServiceIds: { type: [Schema.Types.ObjectId], default: [] },
    price: priceSnapshot,
    amountDueCents: { type: Number, required: true, min: 0 },
    paymentStatus: { type: String, enum: ["not_required", "unconfigured"], required: true },
    idempotencyKey: String,
    createdById: Schema.Types.ObjectId,
    completedAt: Date,
    cancelledAt: Date,
  },
  { timestamps: true }
);
episodeSchema.index({ organizationId: 1, memberId: 1, status: 1 });
episodeSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);
export const AssessmentEpisode = model("AssessmentEpisode", episodeSchema);

// Allowance usage ledger: append-only rows whose status moves
// reserved -> consumed | released. Never deleted; `events` keeps the history.
export const LEDGER_STATUSES = ["reserved", "consumed", "released"] as const;
const ledgerSchema = new Schema(
  {
    organizationId: org,
    memberId: ref("Member"),
    membershipId: ref("MemberMembership"),
    planId: ref("MembershipPlan"),
    benefitId: { type: String, required: true },
    serviceId: ref("Service"),
    appointmentId: optionalRef("Appointment"),
    episodeId: optionalRef("AssessmentEpisode"),
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    quantity: { type: Number, default: 1, min: 1 },
    status: { type: String, enum: LEDGER_STATUSES, default: "reserved" },
    // true while reserved or consumed; the partial unique indexes key on it so
    // one booking/episode can never hold two units.
    holding: { type: Boolean, default: true },
    events: {
      type: [
        new Schema(
          { status: String, at: Date, actorId: String, reason: String },
          { _id: false, versionKey: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);
ledgerSchema.index({ organizationId: 1, memberId: 1, membershipId: 1, benefitId: 1, holding: 1 });
ledgerSchema.index(
  { appointmentId: 1 },
  {
    unique: true,
    partialFilterExpression: { holding: true, appointmentId: { $type: "objectId" } },
  }
);
ledgerSchema.index(
  { episodeId: 1 },
  { unique: true, partialFilterExpression: { holding: true, episodeId: { $type: "objectId" } } }
);
export const AllowanceLedgerEntry = model("AllowanceLedgerEntry", ledgerSchema);

// Serialization points for booking writers (member, provider). Pre-created
// outside the transaction, bumped inside it: concurrent writers conflict and retry.
const lockSchema = new Schema(
  { _id: { type: String, required: true }, revision: { type: Number, default: 0 } },
  { versionKey: false }
);
export const BookingLock = model("BookingLock", lockSchema);
