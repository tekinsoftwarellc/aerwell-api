import { Schema, model } from "mongoose";
const ownership = {
  organizationId: { type: String, required: true, index: true },
  staffId: { type: Schema.Types.ObjectId, required: true, index: true },
};
const employmentSchema = new Schema(
  {
    ...ownership,
    employmentType: {
      type: String,
      enum: ["full_time", "part_time", "contract"],
      default: "full_time",
    },
    startDate: String,
    locationId: Schema.Types.ObjectId,
    compensation: {
      payType: { type: String, enum: ["salary", "hourly"] },
      paySchedule: String,
      annualSalaryCents: Number,
      hourlyRateCents: Number,
    },
  },
  { timestamps: true }
);
employmentSchema.index({ organizationId: 1, staffId: 1 }, { unique: true });
export const Employment = model("Employment", employmentSchema);
export const Certification = model(
  "Certification",
  new Schema(
    {
      ...ownership,
      name: { type: String, required: true },
      issuer: String,
      licenseNumber: String,
      expirationDate: { type: String, required: true },
    },
    { timestamps: true }
  )
);
export const StaffNote = model(
  "StaffNote",
  new Schema(
    {
      ...ownership,
      authorId: { type: Schema.Types.ObjectId, required: true },
      body: { type: String, required: true },
    },
    { timestamps: true }
  )
);
export const StaffFlag = model(
  "StaffFlag",
  new Schema(
    {
      ...ownership,
      label: { type: String, required: true },
      kind: { type: String, default: "custom" },
      resolvedAt: Date,
    },
    { timestamps: true }
  )
);
export const StaffDocument = model(
  "StaffDocument",
  new Schema(
    {
      ...ownership,
      name: { type: String, required: true },
      uploadId: { type: Schema.Types.ObjectId, required: true },
      createdBy: { type: Schema.Types.ObjectId, required: true },
    },
    { timestamps: true }
  )
);
