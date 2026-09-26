import { Schema, model } from "mongoose";
const schema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    staffId: { type: Schema.Types.ObjectId, required: true },
    email: { type: String, required: true },
    roleId: { type: Schema.Types.ObjectId, required: true },
    tokenHash: { type: String, required: true, select: false },
    sentAt: Date,
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: ["pending", "accepted", "revoked"], default: "pending" },
    deliveryStatus: {
      type: String,
      enum: ["unconfigured", "sent", "failed"],
      default: "unconfigured",
    },
  },
  { timestamps: true }
);
schema.index({ organizationId: 1, staffId: 1, status: 1 });
export const Invite = model("Invite", schema);
