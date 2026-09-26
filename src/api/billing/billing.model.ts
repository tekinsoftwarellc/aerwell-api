import { Schema, model } from "mongoose";
import { addressFields } from "../member/member.model.js";

const ownership = {
  organizationId: { type: String, required: true, index: true },
  memberId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
};

// Card on file: processor token + display fields only. A card number, CVC or
// raw PAN never reaches this API (Stripe Elements tokenizes in the browser).
const paymentMethodSchema = new Schema(
  {
    ...ownership,
    processorPaymentMethodId: { type: String, required: true },
    brand: String,
    last4: String,
    expMonth: Number,
    expYear: Number,
    nameOnCard: String,
    billingAddress: addressFields,
  },
  { timestamps: true }
);
paymentMethodSchema.index({ organizationId: 1, memberId: 1 }, { unique: true });
export const PaymentMethod = model("PaymentMethod", paymentMethodSchema);

export const INVOICE_STATUSES = ["draft", "open", "paid", "failed", "void", "refunded"] as const;
// Written only from verified processor webhooks; amounts are integer cents.
const invoiceSchema = new Schema(
  {
    ...ownership,
    processorInvoiceId: { type: String, required: true },
    membershipId: { type: Schema.Types.ObjectId, ref: "MemberMembership" },
    description: { type: String, default: "" },
    amountCents: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "usd" },
    status: { type: String, enum: INVOICE_STATUSES, required: true },
    issuedAt: { type: Date, required: true },
    hostedInvoiceUrl: String,
    lastEventAt: { type: Date, required: true },
  },
  { timestamps: true }
);
invoiceSchema.index({ processorInvoiceId: 1 }, { unique: true });
invoiceSchema.index({ organizationId: 1, memberId: 1, issuedAt: -1 });
export const Invoice = model("Invoice", invoiceSchema);

// Idempotency ledger for processor webhooks: one row per event id, written in
// the same transaction as the event's effect.
const eventSchema = new Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    outcome: { type: String, enum: ["applied", "ignored"], required: true },
    receivedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
eventSchema.index({ eventId: 1 }, { unique: true });
export const ProcessorEvent = model("ProcessorEvent", eventSchema);
