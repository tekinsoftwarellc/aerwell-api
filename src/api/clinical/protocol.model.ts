import { type InferSchemaType, Schema, model } from "mongoose";

export const PROTOCOL_STATUSES = ["active", "completed", "discontinued"] as const;
export const DOSE_UNITS = ["mcg", "mg", "g", "mL", "IU", "units"] as const;
export const FREQUENCY_PERIODS = ["daily", "weekly", "monthly"] as const;
export const ROUTES = [
  "subcutaneous",
  "intramuscular",
  "intravenous",
  "oral",
  "sublingual",
  "topical",
  "intranasal",
] as const;
const item = new Schema({
  compound: { type: String, required: true, trim: true },
  doseAmount: { type: Number, required: true, min: 0 },
  doseUnit: { type: String, enum: DOSE_UNITS, required: true },
  frequencyCount: { type: Number, required: true, min: 1 },
  frequencyPeriod: { type: String, enum: FREQUENCY_PERIODS, required: true },
  route: { type: String, enum: ROUTES, required: true },
});
const protocolSchema = new Schema(
  {
    organizationId: { type: String, required: true },
    memberId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    type: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    prescribingProviderId: { type: Schema.Types.ObjectId, ref: "StaffMember", required: true },
    startDate: { type: String, required: true },
    estEndDate: { type: String, required: true },
    status: { type: String, enum: PROTOCOL_STATUSES, default: "active" },
    items: { type: [item], default: [] },
    supplyRemainingDays: { type: Number, min: 0 },
    nextRefillDue: String,
    lastInjectionSite: String,
    lastLoggedInjectionAt: Date,
    discontinuedReason: String,
    endedAt: Date,
    createdById: Schema.Types.ObjectId,
  },
  { timestamps: true, versionKey: "version" }
);
protocolSchema.index({ organizationId: 1, memberId: 1, status: 1, startDate: -1 });
export type ProtocolData = InferSchemaType<typeof protocolSchema>;
export const Protocol = model("Protocol", protocolSchema);

// Append-only history, written in the same transaction as every protocol change.
export const ProtocolRevision = model(
  "ProtocolRevision",
  new Schema(
    {
      organizationId: { type: String, required: true },
      protocolId: { type: Schema.Types.ObjectId, required: true, index: true },
      memberId: { type: Schema.Types.ObjectId, required: true },
      changedById: { type: Schema.Types.ObjectId, required: true },
      changedAt: { type: Date, default: Date.now },
      action: { type: String, enum: ["adjusted", "discontinued", "completed"], required: true },
      before: { type: Schema.Types.Mixed, required: true },
      after: { type: Schema.Types.Mixed, required: true },
      reason: String,
    },
    { versionKey: false }
  )
);

export const InjectionLog = model(
  "InjectionLog",
  new Schema(
    {
      organizationId: { type: String, required: true },
      protocolId: { type: Schema.Types.ObjectId, required: true },
      memberId: { type: Schema.Types.ObjectId, required: true },
      itemId: { type: Schema.Types.ObjectId, required: true },
      administeredAt: { type: Date, required: true },
      site: { type: String, required: true },
      loggedById: { type: Schema.Types.ObjectId, required: true },
      loggedBy: { type: String, enum: ["staff", "member"], default: "staff" },
    },
    { timestamps: true }
  ).index({ organizationId: 1, protocolId: 1, administeredAt: -1 })
);
