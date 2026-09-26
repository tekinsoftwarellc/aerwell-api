import { Schema, model } from "mongoose";
export const notificationTypes = [
  "billing",
  "approvals",
  "critical_alerts",
  "appointments",
  "members",
  "system",
] as const;
/** Personal delivery matrix when a staff member has saved nothing (W2 Settings). */
export const PREFERENCE_DEFAULTS = {
  billing: { in_app: true, push: true, email: true },
  approvals: { in_app: true, push: true, email: false },
  critical_alerts: { in_app: true, push: true, email: true },
  appointments: { in_app: true, push: false, email: false },
  members: { in_app: true, push: false, email: true },
  system: { in_app: true, push: false, email: true },
};
export const QUIET_HOURS_DEFAULT = { enabled: true, start: "21:00", end: "07:00" };
const channel = {
  in_app: { type: Boolean, default: true },
  push: { type: Boolean, default: false },
  email: { type: Boolean, default: false },
};
const schema = new Schema({
  organizationId: { type: String, required: true },
  staffId: { type: Schema.Types.ObjectId, required: true },
  matrix: {
    billing: channel,
    approvals: channel,
    critical_alerts: channel,
    appointments: channel,
    members: channel,
    system: channel,
  },
  quietHours: {
    enabled: { type: Boolean, default: true },
    start: { type: String, default: "21:00" },
    end: { type: String, default: "07:00" },
  },
});
schema.index({ organizationId: 1, staffId: 1 }, { unique: true });
export const NotificationPreference = model("NotificationPreference", schema);
export const NotificationRule = model(
  "NotificationRule",
  new Schema(
    {
      organizationId: { type: String, required: true, index: true },
      trigger: { type: String, required: true },
      recipient: {
        type: { type: String, required: true },
        id: { type: Schema.Types.ObjectId, required: true },
      },
      channels: { type: [String], default: ["in_app"] },
      enabled: { type: Boolean, default: true },
    },
    { timestamps: true }
  )
);
