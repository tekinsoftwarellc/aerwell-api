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
const planSchema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    brand: { type: String, enum: ["aerwell", "everhaus"], required: true },
    tiers: {
      type: [
        new Schema(
          {
            id: { type: String, required: true },
            name: { type: String, required: true },
            billingTerm: {
              type: String,
              enum: ["monthly", "quarterly", "bi_annual"],
              default: "monthly",
            },
            priceCents: { type: Number, min: 0 },
            pricePending: { type: Boolean, default: true },
            active: { type: Boolean, default: true },
          },
          { _id: false }
        ),
      ],
      required: true,
    },
  },
  { timestamps: true }
);
planSchema.index({ organizationId: 1, brand: 1 }, { unique: true });
export const MembershipPlan = model("MembershipPlan", planSchema);
const serviceSchema = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    shortName: String,
    description: { type: String, default: "" },
    imageKey: String,
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    categoryId: { type: Schema.Types.ObjectId, ref: "ServiceCategory", required: true },
    locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true },
    environmentId: { type: Schema.Types.ObjectId, ref: "Environment", required: true },
    durationMinutes: { type: Number, required: true, min: 1 },
    capacityMin: { type: Number, required: true, min: 1 },
    capacityMax: { type: Number, required: true, min: 1 },
    basePriceCents: { type: Number, required: true, min: 0 },
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
    membershipAccess: {
      type: [
        new Schema(
          {
            membershipPlanId: {
              type: Schema.Types.ObjectId,
              ref: "MembershipPlan",
              required: true,
            },
            enabled: { type: Boolean, required: true },
            tiers: {
              type: [
                new Schema(
                  {
                    tierId: { type: String, required: true },
                    mode: { type: String, enum: ["off", "included", "paid"], required: true },
                    priceCents: { type: Number, min: 0 },
                  },
                  { _id: false }
                ),
              ],
              default: [],
            },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    assignedStaffIds: { type: [{ type: Schema.Types.ObjectId, ref: "StaffMember" }], default: [] },
    assignedTeamRoleId: { type: Schema.Types.ObjectId, ref: "Role", default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
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
