import { Schema, model } from "mongoose";
const credentialSchema = new Schema({
  organizationId: { type: String, required: true },
  staffId: { type: Schema.Types.ObjectId, required: true, unique: true },
  passwordHash: { type: String, required: true, select: false },
  version: { type: Number, default: 0 },
  failedAttempts: { type: Number, default: 0 },
  lockedUntil: Date,
});
export const StaffCredential = model("StaffCredential", credentialSchema);
const sessionSchema = new Schema(
  {
    organizationId: { type: String, required: true },
    staffId: { type: Schema.Types.ObjectId, required: true, index: true },
    credentialVersion: { type: Number, required: true },
    currentHash: { type: String, required: true, unique: true },
    usedHashes: { type: [String], default: [], index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
  },
  { timestamps: true }
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const StaffSession = model("StaffSession", sessionSchema);
const challengeSchema = new Schema({
  organizationId: { type: String, required: true },
  staffId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ["otp", "reset", "invite"], required: true },
  tokenHash: { type: String, required: true, index: true },
  credentialVersion: { type: Number, required: true },
  attempts: { type: Number, default: 0 },
  consumedAt: Date,
  expiresAt: { type: Date, required: true },
});
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AuthChallenge = model("AuthChallenge", challengeSchema);
