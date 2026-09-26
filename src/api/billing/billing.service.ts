import type { Request } from "express";
import { NotFoundError, ValidationError } from "../../common/errors/AppError.js";
import { pagination } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import { Member, type MemberDocument } from "../member/member.model.js";
import { memberScope, memberTarget } from "../member/member.scope.js";
import { getBillingAdapter, paymentsUnconfigured } from "./billing.adapter.js";
import { Invoice, PaymentMethod } from "./billing.model.js";

const BILLING = { modules: ["BILLING" as const] };
const DISPLAY = "brand last4 expMonth expYear nameOnCard billingAddress updatedAt";

export function billingConfig() {
  const adapter = getBillingAdapter();
  return { configured: adapter.configured, publishableKey: adapter.publishableKey };
}

async function customerFor(member: MemberDocument) {
  if (member.processorCustomerId) return member.processorCustomerId;
  const id = await getBillingAdapter().createCustomer({
    memberId: String(member._id),
    organizationId: member.organizationId,
  });
  // Conditional write: a concurrent request that stored a customer first wins.
  await Member.updateOne(
    { _id: member._id, processorCustomerId: { $exists: false } },
    { $set: { processorCustomerId: id } }
  );
  const stored = await Member.findById(member._id).select("processorCustomerId").lean();
  return stored?.processorCustomerId ?? id;
}

export async function createSetupIntent(req: Request) {
  const member = await memberTarget(req, { ...BILLING, write: true });
  if (!getBillingAdapter().configured) throw paymentsUnconfigured();
  const intent = await getBillingAdapter().createSetupIntent(await customerFor(member));
  await audit(req, "created", "SetupIntent", intent.id, String(member._id));
  return { clientSecret: intent.clientSecret };
}

export async function getPaymentMethod(req: Request) {
  const member = await memberTarget(req, BILLING);
  const row = await PaymentMethod.findOne({
    organizationId: member.organizationId,
    memberId: member._id,
  })
    .select(DISPLAY)
    .lean();
  await audit(req, "viewed", "PaymentMethod", String(member._id), String(member._id));
  return { paymentsConfigured: getBillingAdapter().configured, paymentMethod: row };
}

/** Stores the Stripe-tokenized card attached by the SetupIntent (display fields only). */
export async function putPaymentMethod(req: Request) {
  const member = await memberTarget(req, { ...BILLING, write: true });
  const adapter = getBillingAdapter();
  if (!adapter.configured) throw paymentsUnconfigured();
  const card = await adapter.retrievePaymentMethod(req.body.processorPaymentMethodId);
  if (!member.processorCustomerId || card.customerId !== member.processorCustomerId || !card.last4)
    throw new ValidationError(
      "This card was not saved for this member. Add it again.",
      "PAYMENT_METHOD_MISMATCH"
    );
  await PaymentMethod.updateOne(
    { organizationId: member.organizationId, memberId: member._id },
    {
      $set: {
        processorPaymentMethodId: card.id,
        brand: card.brand,
        last4: card.last4,
        expMonth: card.expMonth,
        expYear: card.expYear,
        nameOnCard: req.body.nameOnCard,
        billingAddress: req.body.billingAddress ?? {},
      },
    },
    { upsert: true, runValidators: true }
  );
  await audit(req, "updated", "PaymentMethod", String(member._id), String(member._id));
  const paymentMethod = await PaymentMethod.findOne({ memberId: member._id })
    .select(DISPLAY)
    .lean();
  return { paymentsConfigured: true, paymentMethod };
}

export async function listInvoices(req: Request) {
  const member = await memberTarget(req, BILLING);
  const page = Number(req.query["page"]);
  const limit = Number(req.query["limit"]);
  const filter = { organizationId: member.organizationId, memberId: member._id };
  const [items, total] = await Promise.all([
    Invoice.find(filter)
      .sort({ issuedAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("description amountCents currency status issuedAt")
      .lean(),
    Invoice.countDocuments(filter),
  ]);
  await audit(req, "viewed", "MemberInvoices", String(member._id), String(member._id));
  return {
    items,
    pagination: pagination(page, limit, total),
    paymentsConfigured: getBillingAdapter().configured,
  };
}

export async function invoicePdf(req: Request) {
  const invoice = await Invoice.findById(req.params["id"]).lean();
  // Scope through the owning member: another org or an unassigned member is a 404.
  if (
    !invoice ||
    !(await Member.exists({ _id: invoice.memberId, ...(await memberScope(req, BILLING.modules)) }))
  )
    throw new NotFoundError("Invoice not found");
  if (!invoice.hostedInvoiceUrl) throw new NotFoundError("Invoice document not available");
  await audit(req, "viewed", "Invoice", String(invoice._id), String(invoice.memberId));
  return { url: invoice.hostedInvoiceUrl };
}
