import { type InferSchemaType, Schema, model } from "mongoose";
import { MODULES } from "./permission.types.js";
export const permissionFields = {
  module: { type: String, enum: MODULES, required: true },
  level: { type: String, enum: ["none", "view", "edit", "master"], required: true },
  scope: { type: String, enum: ["all", "own"], default: "all", required: true },
} as const;
const schema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    shortCode: String,
    color: String,
    department: String,
    summary: String,
    permissions: {
      type: [new Schema(permissionFields, { _id: false })],
      required: true,
      validate: {
        validator: (v: { module: string }[]) =>
          v.length === MODULES.length && new Set(v.map((p) => p.module)).size === MODULES.length,
        message: "Exactly one permission per module is required",
      },
    },
  },
  { timestamps: true }
);
schema.index({ organizationId: 1, name: 1 }, { unique: true });
export type RoleData = InferSchemaType<typeof schema>;
export const Role = model("Role", schema);
