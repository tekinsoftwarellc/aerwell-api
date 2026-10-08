import { Schema, model } from "mongoose";

/**
 * One Alfred POST (contract §4.6). The row is CLAIMED (`pending`) before the handler runs and
 * filled in (`done`) with the exact status and body afterwards, so a replay answers identically
 * and two copies in flight cannot both execute.
 */
const schema = new Schema(
  {
    organizationId: { type: String, required: true },
    /** The ROUTE pattern, not the filled-in URL. */
    path: { type: String, required: true },
    key: { type: String, required: true },
    method: { type: String, required: true },
    /** sha256 of the canonical (key-sorted) JSON body. */
    bodyHash: { type: String, required: true },
    state: { type: String, enum: ["pending", "done"], default: "pending" },
    claimedAt: { type: Date, default: Date.now },
    statusCode: Number,
    responseBody: Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
schema.index({ organizationId: 1, path: 1, key: 1 }, { unique: true });
// §4.6: the partner keeps the key for 24 hours.
schema.index({ createdAt: 1 }, { expireAfterSeconds: 86_400 });
export const PartnerIdempotencyKey = model(
  "PartnerIdempotencyKey",
  schema,
  "partner_idempotency_keys"
);
