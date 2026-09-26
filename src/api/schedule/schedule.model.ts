import { Schema, model } from "mongoose";
import { ONBOARDING_STEPS, PTO_STATUSES, PTO_TYPES } from "./schedule.schema.js";
const org = { type: String, required: true, index: true };
const ref = { type: Schema.Types.ObjectId, required: true };
const shiftSchema = new Schema(
  {
    organizationId: org,
    staffId: { type: Schema.Types.ObjectId, ref: "StaffMember", default: null },
    date: { type: String, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    timeZone: { type: String, required: true },
    positionRoleId: { ...ref, ref: "Role" },
    locationId: { ...ref, ref: "Location" },
    stationName: String,
  },
  { timestamps: true }
);
shiftSchema.index({ organizationId: 1, staffId: 1, startAt: 1, endAt: 1 });
shiftSchema.index({ organizationId: 1, date: 1 });
export const Shift = model("Shift", shiftSchema);
const availabilitySchema = new Schema(
  {
    organizationId: org,
    staffId: { ...ref, ref: "StaffMember" },
    days: [
      new Schema(
        {
          weekday: { type: Number, required: true },
          available: { type: Boolean, required: true },
          start: String,
          end: String,
        },
        { _id: false }
      ),
    ],
  },
  { timestamps: true }
);
availabilitySchema.index({ organizationId: 1, staffId: 1 }, { unique: true });
export const Availability = model("Availability", availabilitySchema);
const ptoSchema = new Schema(
  {
    organizationId: org,
    staffId: { ...ref, ref: "StaffMember" },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    days: { type: Number, required: true },
    type: { type: String, enum: PTO_TYPES, required: true },
    note: String,
    status: { type: String, enum: PTO_STATUSES, default: "pending" },
    reason: String,
    decidedBy: Schema.Types.ObjectId,
    decidedAt: Date,
  },
  { timestamps: true }
);
ptoSchema.index({ organizationId: 1, staffId: 1, status: 1, startDate: 1, endDate: 1 });
export const PtoRequest = model("PtoRequest", ptoSchema);
const balanceSchema = new Schema(
  {
    organizationId: org,
    staffId: { ...ref, ref: "StaffMember" },
    year: { type: Number, required: true },
    // Per-staff override; absent means the organization default applies.
    allowanceDays: Number,
    usedDays: { type: Number, default: 0 },
  },
  { timestamps: true }
);
balanceSchema.index({ organizationId: 1, staffId: 1, year: 1 }, { unique: true });
export const PtoBalance = model("PtoBalance", balanceSchema);
const onboardingSchema = new Schema(
  {
    organizationId: org,
    staffId: { ...ref, ref: "StaffMember" },
    steps: [
      new Schema(
        {
          key: { type: String, enum: ONBOARDING_STEPS, required: true },
          complete: { type: Boolean, default: false },
        },
        { _id: false }
      ),
    ],
  },
  { timestamps: true }
);
onboardingSchema.index({ organizationId: 1, staffId: 1 }, { unique: true });
export const OnboardingChecklist = model("OnboardingChecklist", onboardingSchema);
