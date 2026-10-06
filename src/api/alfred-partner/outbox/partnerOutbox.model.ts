import { Schema, model } from "mongoose";

export const OUTBOX_STATUSES = ["pending", "sending", "sent", "failed", "dead"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/**
 * One event owed to Alfred (`POST /api/v1/partner/events`). The row is written in the same Mongo
 * transaction as the change it reports, so a crash after commit loses nothing. It holds no member
 * name, contact detail or clinical content: only ids, times, display titles and amounts.
 */
const schema = new Schema(
  {
    organizationId: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    type: { type: String, required: true },
    occurredAt: { type: Date, required: true },
    accountId: String,
    resource: {
      type: new Schema({ kind: String, ref: String }, { _id: false }),
      required: true,
    },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: OUTBOX_STATUSES, default: "pending" },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lastError: String,
    lastStatusCode: Number,
    alfredEventId: String,
  },
  { timestamps: true }
);
schema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1 });
export const PartnerOutbox = model("PartnerOutbox", schema, "partner_outbox");
