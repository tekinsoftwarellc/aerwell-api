import { type InferSchemaType, Schema, model } from "mongoose";
import { notificationTypes } from "./preference.model.js";

// In-app notifications, one row per recipient. Titles never carry member
// names or clinical values; the link opens the record behind the reader's
// own permission checks. `deliverAfter` defers a row through quiet hours:
// it exists at once but stays out of the inbox (and the unread count) until then.
export const NOTIFICATION_KINDS = [
  "pto_requested",
  "pto_decided",
  "appointment_booked",
  "appointment_rescheduled",
  "appointment_cancelled",
  "lab_review",
  "scan_review",
  "flag_raised",
  "payment_failed",
  "invite_accepted",
  "certification_expiring",
  // Reserved: W8 has no critical-value definition yet, so nothing produces it.
  "critical_lab_result",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationType = (typeof notificationTypes)[number];
const outbound = { type: String, enum: ["off", "unconfigured"], required: true };
const schema = new Schema(
  {
    organizationId: { type: String, required: true },
    recipientStaffId: { type: Schema.Types.ObjectId, ref: "StaffMember", required: true },
    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },
    category: { type: String, enum: notificationTypes, required: true },
    title: { type: String, required: true, maxlength: 200 },
    link: { type: String, default: null },
    critical: { type: Boolean, default: false },
    deliverAfter: { type: Date, required: true },
    readAt: { type: Date, default: null },
    // Email and push are never sent yet: "unconfigured" records that the
    // recipient asked for the channel, "off" that they did not.
    deliveries: {
      in_app: { type: String, enum: ["delivered", "deferred"], required: true },
      email: outbound,
      push: outbound,
    },
    dedupeKey: { type: String, default: undefined },
  },
  { timestamps: true }
);
schema.index({ organizationId: 1, recipientStaffId: 1, _id: -1 });
schema.index({ organizationId: 1, recipientStaffId: 1, readAt: 1, deliverAfter: 1 });
schema.index(
  { organizationId: 1, recipientStaffId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }
);
export type NotificationData = InferSchemaType<typeof schema>;
export const Notification = model("Notification", schema);
