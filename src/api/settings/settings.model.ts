import { Schema, model } from "mongoose";
const schema = new Schema(
  {
    organizationId: { type: String, required: true, unique: true },
    scheduleRevision: { type: Number, default: 0 },
    staffAccessRevision: { type: Number, default: 0 },
    name: { type: String, default: "Aerwell" },
    logoUrl: String,
    logoUploadId: Schema.Types.ObjectId,
    tagline: String,
    workspaceAddress: String,
    primaryLocationId: { type: Schema.Types.ObjectId, ref: "Location" },
    timeZone: { type: String, default: "America/Los_Angeles" },
    dateFormat: {
      type: String,
      enum: ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"],
      default: "MM/DD/YYYY",
    },
    measurementSystem: { type: String, enum: ["imperial", "metric"], default: "imperial" },
    currency: { type: String, default: "USD" },
    security: {
      autoSignOutMinutes: { type: Number, default: 30 },
      requireTwoFactor: { type: Boolean, default: false },
    },
    ptoAllowanceDays: { type: Number, default: 15 },
  },
  { timestamps: true }
);
export const OrganizationSettings = model("OrganizationSettings", schema);
