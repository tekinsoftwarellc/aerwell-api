import { type HydratedDocument, type InferSchemaType, Schema, model } from "mongoose";

// Local member records are Aerwell CLINICAL records, not an identity provider:
// no credentials are ever stored or minted here. `alfredAccountId` is an
// optional link to the Alfred platform identity, written only by a verified
// integration (unconfigured today, so it stays unset).
export const MEMBER_STATUSES = [
  "pending_onboarding",
  "active",
  "cancellation_requested",
  "paused",
  "cancelled",
] as const;
export const FLAG_CATEGORIES = [
  "waitlist",
  "outstanding_balance",
  "flagged_for_review",
  "allergy",
  "clinical",
  "billing",
  "attendance",
  "new_result",
  "custom",
] as const;
const ownership = {
  organizationId: { type: String, required: true, index: true },
  memberId: { type: Schema.Types.ObjectId, ref: "Member", required: true, index: true },
};
const address = {
  line1: String,
  line2: String,
  city: String,
  state: String,
  postalCode: String,
  country: String,
};

const memberSchema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    alfredAccountId: { type: String, default: undefined },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: String,
    dateOfBirth: String,
    sex: { type: String, enum: ["male", "female"] },
    address,
    emergencyContact: { name: String, phone: String },
    photoUploadId: Schema.Types.ObjectId,
    status: { type: String, enum: MEMBER_STATUSES, default: "pending_onboarding" },
    intakeNote: String,
    homeLocationId: { type: Schema.Types.ObjectId, ref: "Location" },
    // Own-scope staff (MEMBER_RECORDS etc. scope "own") see only these members.
    assignedClinicianIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "StaffMember" }],
      default: [],
    },
    lastVisitAt: { type: Date, default: null },
    processorCustomerId: { type: String, default: undefined },
    // Bumped inside membership transactions so concurrent writers conflict.
    membershipRevision: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },
    archivedById: Schema.Types.ObjectId,
    createdById: Schema.Types.ObjectId,
  },
  { timestamps: true }
);
memberSchema.index({ organizationId: 1, email: 1 }, { unique: true });
memberSchema.index(
  { organizationId: 1, alfredAccountId: 1 },
  { unique: true, partialFilterExpression: { alfredAccountId: { $type: "string" } } }
);
memberSchema.index(
  { processorCustomerId: 1 },
  { unique: true, partialFilterExpression: { processorCustomerId: { $type: "string" } } }
);
memberSchema.index({ organizationId: 1, status: 1, lastName: 1 });
memberSchema.index({ organizationId: 1, assignedClinicianIds: 1 });
export type MemberData = InferSchemaType<typeof memberSchema>;
export type MemberDocument = HydratedDocument<MemberData>;
export const Member = model("Member", memberSchema);

// One record per held membership. Several may be active at once (overlap);
// the pure evaluator reads them as MembershipHolding (id, planId, status,
// startedAt = anniversary anchor, endsAt).
const membershipSchema = new Schema(
  {
    ...ownership,
    planId: { type: Schema.Types.ObjectId, ref: "MembershipPlan", required: true },
    status: {
      type: String,
      enum: ["active", "past_due", "paused", "cancelled"],
      default: "active",
    },
    startedAt: { type: Date, required: true },
    endsAt: { type: Date, default: null },
    // Anniversary anchor for benefit periods (implementation default, see W4r).
    periodAnchor: { type: String, enum: ["anniversary"], default: "anniversary" },
    // Plan price snapshot at start; null when the plan has no price configured.
    priceCents: { type: Number, min: 0, default: null },
    billingTerm: { type: String, default: null },
    autoRenew: { type: Boolean, default: true },
    processorSubscriptionId: { type: String, default: undefined },
    cancelledAt: Date,
    createdById: Schema.Types.ObjectId,
  },
  { timestamps: true, versionKey: "version", optimisticConcurrency: true }
);
membershipSchema.index({ organizationId: 1, memberId: 1, status: 1 });
membershipSchema.index(
  { processorSubscriptionId: 1 },
  { unique: true, partialFilterExpression: { processorSubscriptionId: { $type: "string" } } }
);
export const MemberMembership = model("MemberMembership", membershipSchema);

const flagSchema = new Schema(
  {
    ...ownership,
    category: { type: String, enum: FLAG_CATEGORIES, required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    severity: { type: String, enum: ["urgent", "open"], default: "open" },
    relatedServiceId: { type: Schema.Types.ObjectId, ref: "Service" },
    raisedBy: { type: String, required: true },
    raisedAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date, default: null },
    resolvedById: Schema.Types.ObjectId,
  },
  { timestamps: true }
);
flagSchema.index({ organizationId: 1, memberId: 1, resolvedAt: 1, raisedAt: -1 });
flagSchema.index({ organizationId: 1, category: 1, resolvedAt: 1 });
export const MemberFlag = model("MemberFlag", flagSchema);

const noteSchema = new Schema(
  {
    ...ownership,
    authorId: { type: Schema.Types.ObjectId, ref: "StaffMember", required: true },
    appointmentId: Schema.Types.ObjectId,
    body: { type: String, required: true },
    recordingOffsetSec: { type: Number, min: 0 },
    readBy: { type: [Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true }
);
noteSchema.index({ organizationId: 1, memberId: 1, createdAt: -1 });
export const MemberNote = model("MemberNote", noteSchema);

export const VIEW_CONTEXTS = ["member_profile", "member_appointment"] as const;
export const VIEW_CARDS = [
  "appointment",
  "alfred",
  "health",
  "labs",
  "scans",
  "meds",
  "supps",
  "protocols",
  "orders",
  "membership",
  "notes",
  "messages",
] as const;
const viewSchema = new Schema(
  {
    organizationId: { type: String, required: true },
    staffId: { type: Schema.Types.ObjectId, required: true },
    context: { type: String, enum: VIEW_CONTEXTS, required: true },
    layout: { type: Number, enum: [1, 2, 3], required: true },
    columns: { type: [[{ type: String, enum: VIEW_CARDS }]], required: true },
  },
  { timestamps: true }
);
viewSchema.index({ organizationId: 1, staffId: 1, context: 1 }, { unique: true });
export const ViewPreference = model("ViewPreference", viewSchema);

export { address as addressFields };
