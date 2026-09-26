import { createHmac, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import mongoose, { type ClientSession } from "mongoose";
import { z } from "zod";
import { BadRequestError } from "../../common/errors/AppError.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { asyncHandler } from "../../common/utils/asyncHandler.js";
import { env } from "../../config/env.js";
import { AuditEvent } from "../audit/audit.js";
import { Member, MemberMembership } from "../member/member.model.js";
import { paymentsUnconfigured } from "./billing.adapter.js";
import { Invoice, ProcessorEvent } from "./billing.model.js";

const TOLERANCE_SECONDS = 300;
const ACTOR = "system:stripe";
const invalidSignature = () =>
  new BadRequestError("Invalid webhook signature", undefined, "INVALID_SIGNATURE");

/** Stripe's scheme: HMAC-SHA256(secret, `${t}.${rawBody}`), any matching v1, within tolerance. */
export function verifyStripeSignature(
  raw: string,
  header: string | undefined,
  secret: string,
  nowSeconds: number
) {
  const parts = (header ?? "")
    .split(",")
    .map((part) => part.split("=", 2) as [string, string | undefined]);
  const t = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value ?? "");
  if (!Number.isInteger(t) || !signatures.length) throw invalidSignature();
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) throw invalidSignature();
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex"));
  const matches = signatures.some((sig) => {
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) throw invalidSignature();
}

const eventSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  created: z.number().int(),
  data: z.object({ object: z.record(z.unknown()) }),
});
type StripeEvent = z.infer<typeof eventSchema>;
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const INVOICE_STATUS: Record<string, string> = {
  "invoice.paid": "paid",
  "invoice.payment_failed": "failed",
  "invoice.voided": "void",
  "invoice.finalized": "open",
};
const STATUS_RANK: Record<string, number> = {
  draft: 0,
  open: 1,
  failed: 2,
  paid: 3,
  void: 3,
  refunded: 4,
};
const SUBSCRIPTION_STATUS: Record<string, string> = {
  active: "active",
  trialing: "active",
  past_due: "past_due",
  unpaid: "past_due",
  paused: "paused",
  canceled: "cancelled",
  incomplete_expired: "cancelled",
};

async function systemAudit(
  session: ClientSession,
  organizationId: string,
  targetType: string,
  targetId: string,
  memberId: string
) {
  await AuditEvent.create(
    [
      {
        organizationId,
        actorId: ACTOR,
        action: "processor_updated",
        targetType,
        targetId,
        memberId,
      },
    ],
    { session }
  );
}

async function applyInvoice(event: StripeEvent, session: ClientSession): Promise<boolean> {
  const object = event.data.object;
  const status = INVOICE_STATUS[event.type];
  const invoiceId = str(object["id"]);
  const member = await Member.findOne({
    processorCustomerId: str(object["customer"]) ?? "",
  }).session(session);
  if (!(status && invoiceId && member)) return false;
  const eventAt = new Date(event.created * 1000);
  const existing = await Invoice.findOne({ processorInvoiceId: invoiceId }).session(session);
  // Out-of-order delivery: an older event never overwrites a newer state. Stripe
  // timestamps are whole seconds, so within one second the later lifecycle state wins.
  if (existing) {
    const newer = existing.lastEventAt < eventAt;
    const sameSecondProgress =
      existing.lastEventAt.getTime() === eventAt.getTime() &&
      (STATUS_RANK[status] ?? 0) > (STATUS_RANK[existing.status] ?? 0);
    if (!(newer || sameSecondProgress)) return false;
  }
  const amount = Number(status === "paid" ? object["amount_paid"] : object["amount_due"]);
  if (!Number.isSafeInteger(amount) || amount < 0) return false;
  const fields = {
    organizationId: member.organizationId,
    memberId: member._id,
    description: str(object["description"]) ?? "",
    amountCents: amount,
    currency: str(object["currency"]) ?? "usd",
    status,
    issuedAt: new Date(Number(object["created"] ?? event.created) * 1000),
    hostedInvoiceUrl: str(object["hosted_invoice_url"]),
    lastEventAt: eventAt,
  };
  const row = existing
    ? await Invoice.findOneAndUpdate(
        { _id: existing._id },
        { $set: fields },
        { new: true, session }
      )
    : (await Invoice.create([{ ...fields, processorInvoiceId: invoiceId }], { session }))[0];
  if (!row) return false;
  await systemAudit(session, member.organizationId, "Invoice", String(row._id), String(member._id));
  return true;
}

async function applySubscription(event: StripeEvent, session: ClientSession): Promise<boolean> {
  const object = event.data.object;
  const status =
    event.type === "customer.subscription.deleted"
      ? "cancelled"
      : SUBSCRIPTION_STATUS[str(object["status"]) ?? ""];
  const row = await MemberMembership.findOne({
    processorSubscriptionId: str(object["id"]) ?? "",
  }).session(session);
  if (!(status && row) || row.status === "cancelled") return false;
  row.status = status as typeof row.status;
  if (status === "cancelled") row.cancelledAt = new Date(event.created * 1000);
  await row.save({ session });
  await systemAudit(
    session,
    row.organizationId,
    "MemberMembership",
    String(row._id),
    String(row.memberId)
  );
  return true;
}

/** Records the event id and its effect in one transaction; a repeated id is a no-op. */
export async function handleStripeEvent(event: StripeEvent) {
  try {
    await mongoose.connection.transaction(async (session) => {
      const applied = event.type.startsWith("invoice.")
        ? await applyInvoice(event, session)
        : event.type.startsWith("customer.subscription.")
          ? await applySubscription(event, session)
          : false;
      await ProcessorEvent.create(
        [{ eventId: event.id, type: event.type, outcome: applied ? "applied" : "ignored" }],
        {
          session,
        }
      );
    });
    return { received: true, duplicate: false };
  } catch (error) {
    const duplicate = error as { code?: number; keyPattern?: Record<string, unknown> };
    if (duplicate.code === 11000 && duplicate.keyPattern?.["eventId"])
      return { received: true, duplicate: true };
    throw error;
  }
}

export const webhookRouter = Router();
webhookRouter.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json", limit: "256kb" }),
  asyncHandler(async (req, res) => {
    const secret = env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw paymentsUnconfigured();
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    verifyStripeSignature(raw, req.get("stripe-signature"), secret, Math.floor(Date.now() / 1000));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestError("Invalid event body");
    }
    const event = eventSchema.safeParse(parsed);
    if (!event.success) throw new BadRequestError("Invalid event body");
    res.json(ServiceResponse.success("OK", await handleStripeEvent(event.data)));
  })
);
