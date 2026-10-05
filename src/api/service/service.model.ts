import { Schema, model } from "mongoose";
const categorySchema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    color: { type: String, required: true },
    sortOrder: { type: Number, required: true },
  },
  { timestamps: true }
);
categorySchema.index({ organizationId: 1, name: 1 }, { unique: true });
export const ServiceCategory = model("ServiceCategory", categorySchema);
const serviceSchema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    shortName: String,
    description: { type: String, default: "" },
    imageKey: String,
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    categoryId: { type: Schema.Types.ObjectId, ref: "ServiceCategory", required: true },
    slug: String,
    modality: { type: String, enum: ["physical", "virtual"], default: "physical" },
    // "listed" with no markets = offered nowhere (fail closed).
    marketScope: { type: String, enum: ["all", "listed"], default: "listed" },
    marketIds: { type: [{ type: Schema.Types.ObjectId, ref: "Market" }], default: [] },
    bundleComponentIds: { type: [{ type: Schema.Types.ObjectId, ref: "Service" }], default: [] },
    locationId: { type: Schema.Types.ObjectId, ref: "Location", default: null },
    environmentId: { type: Schema.Types.ObjectId, ref: "Environment", default: null },
    durationMinutes: { type: Number, required: true, min: 1 },
    capacityMin: { type: Number, required: true, min: 1 },
    capacityMax: { type: Number, required: true, min: 1 },
    // Null = no retail price (entitlement-only, e.g. Sanctuary).
    basePriceCents: { type: Number, min: 0, default: null },
    lateCancellationFee: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: false },
          amountCents: { type: Number, min: 0 },
          windowHours: { type: Number, min: 1, default: 24 },
        },
        { _id: false }
      ),
      default: () => ({ enabled: false, windowHours: 24 }),
    },
    assignedStaffIds: { type: [{ type: Schema.Types.ObjectId, ref: "StaffMember" }], default: [] },
    assignedTeamRoleId: { type: Schema.Types.ObjectId, ref: "Role", default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: "version", optimisticConcurrency: true }
);
serviceSchema.index(
  { organizationId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { slug: { $type: "string" } } }
);
serviceSchema.index({ organizationId: 1, deletedAt: 1, status: 1, categoryId: 1, createdAt: -1 });
export const Service = model("Service", serviceSchema);
const imageSchema = new Schema(
  {
    organizationId: { type: String, required: true },
    actorId: { type: String, required: true },
    key: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
imageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const ServiceImageUpload = model("ServiceImageUpload", imageSchema);
