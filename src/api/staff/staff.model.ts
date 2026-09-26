import { type HydratedDocument, type InferSchemaType, Schema, model } from "mongoose";
import { permissionFields } from "../role/role.model.js";
const schema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    authAccountId: { type: String },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: String,
    dateOfBirth: String,
    sex: { type: String, enum: ["male", "female"] },
    address: {
      line1: String,
      line2: String,
      city: String,
      state: String,
      postalCode: String,
      country: String,
    },
    photoUrl: String,
    photoUploadId: Schema.Types.ObjectId,
    titlePrefix: String,
    displayName: String,
    roleId: { type: Schema.Types.ObjectId, ref: "Role" },
    permissionOverrides: {
      type: [new Schema(permissionFields, { _id: false })],
      default: [],
      validate: {
        validator: (v: { module: string }[]) => new Set(v.map((p) => p.module)).size === v.length,
        message: "Duplicate permission override",
      },
    },
    isSuperAdmin: { type: Boolean, default: false },
    isProvider: { type: Boolean, default: false },
    homeLocationId: { type: Schema.Types.ObjectId, ref: "Location" },
    accountStatus: {
      type: String,
      enum: ["pending_onboarding", "active", "deactivated"],
      default: "pending_onboarding",
    },
    lastLoginAt: Date,
    deactivation: { at: Date, byId: String, reason: String, notes: String },
    deletedAt: Date,
  },
  { timestamps: true }
);
schema.index({ organizationId: 1, email: 1 }, { unique: true });
schema.index(
  { organizationId: 1, authAccountId: 1 },
  { unique: true, partialFilterExpression: { authAccountId: { $type: "string" } } }
);
schema.index({ organizationId: 1, accountStatus: 1, lastName: 1 });
export type StaffData = InferSchemaType<typeof schema>;
export type StaffDocument = HydratedDocument<StaffData>;
export const StaffMember = model("StaffMember", schema);
