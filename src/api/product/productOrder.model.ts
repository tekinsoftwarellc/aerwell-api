import { type InferSchemaType, Schema, model } from "mongoose";

export const PRODUCT_ORDER_STATUSES = [
  "placed",
  "paid",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
] as const;
export type ProductOrderStatus = (typeof PRODUCT_ORDER_STATUSES)[number];

/**
 * A product Alfred sold for Aerwell (contract §5.10). Separate from `SupplementOrder`, which is a
 * clinician's draft prescription and is what makes a product orderable by that member. The shipping
 * address is PHI-adjacent: it lives here only, is `select: false`, and is never logged or put in an event.
 */
const itemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, required: true },
    itemRef: { type: String, required: true },
    title: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPriceCents: { type: Number, required: true, min: 0 },
    lineTotalCents: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);
const schema = new Schema(
  {
    organizationId: { type: String, required: true },
    memberId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    accountId: { type: String, required: true },
    items: { type: [itemSchema], required: true },
    shippingAddress: {
      type: new Schema(
        {
          line1: String,
          line2: String,
          city: String,
          region: String,
          postalCode: String,
          country: String,
        },
        { _id: false }
      ),
      select: false,
    },
    totals: {
      type: new Schema(
        {
          subtotalCents: { type: Number, required: true },
          shippingCents: { type: Number, required: true },
          taxCents: { type: Number, required: true },
          totalCents: { type: Number, required: true },
          currency: { type: String, default: "usd" },
        },
        { _id: false }
      ),
      required: true,
    },
    status: { type: String, enum: PRODUCT_ORDER_STATUSES, default: "placed" },
    acceptedTermsVersion: String,
    alfredOrderRef: String,
    paymentIntentId: String,
    paidAt: Date,
    paidCents: { type: Number, default: 0 },
    refundedAt: Date,
    refundedCents: { type: Number, default: 0 },
    /** What Alfred owes back for a cancelled order: all of it if it was paid, nothing if it was not. */
    cancelRefundCents: { type: Number, default: 0 },
    tracking: {
      carrier: String,
      number: String,
      url: String,
    },
    shippedAt: Date,
    deliveredAt: Date,
    cancelledAt: Date,
    cancelledBy: { type: String, enum: ["member", "staff", "system"] },
    /** Set with the status flip that gives the units back, so they return exactly once. */
    stockReleased: { type: Boolean, default: false },
  },
  { timestamps: true }
);
schema.index({ organizationId: 1, memberId: 1, updatedAt: 1, _id: 1 });
schema.index({ organizationId: 1, updatedAt: 1, _id: 1 });
// The auto-release sweep: unpaid placed orders by age.
schema.index({ status: 1, createdAt: 1 });
export const ProductOrder = model("ProductOrder", schema);
export type ProductOrderData = InferSchemaType<typeof schema>;
