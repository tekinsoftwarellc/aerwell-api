import { createHmac } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../config/env.js";
import { createServer } from "../../server.js";
import { ORG, memberRow } from "../../test/memberFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { MembershipPlan } from "../catalog/catalog.model.js";
import { type MemberDocument, MemberMembership } from "../member/member.model.js";
import { Invoice, ProcessorEvent } from "./billing.model.js";
import { verifyStripeSignature } from "./webhook.js";

// Locally generated signatures only: a synthetic secret, never a real Stripe one.
const SECRET = "whsec_test_synthetic_local_only";
let app: ReturnType<typeof createServer>;
let member: MemberDocument;
beforeEach(async () => {
  env.STRIPE_WEBHOOK_SECRET = SECRET;
  app = createServer();
  member = await memberRow({ processorCustomerId: "cus_synthetic" });
});
afterEach(() => {
  env.STRIPE_WEBHOOK_SECRET = undefined;
});
const now = () => Math.floor(Date.now() / 1000);
const sign = (raw: string, t = now(), secret = SECRET) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
const invoiceEvent = (id: string, fields: Record<string, unknown> = {}, created = now()) =>
  JSON.stringify({
    id,
    type: "invoice.paid",
    created,
    data: {
      object: {
        id: "in_synthetic",
        customer: "cus_synthetic",
        status: "paid",
        amount_paid: 30000,
        amount_due: 30000,
        currency: "usd",
        created,
        description: "Aerwell Membership Renewal",
        hosted_invoice_url: "https://invoice.example.invalid/in_synthetic",
        ...fields,
      },
    },
  });
const deliver = (raw: string, signature = sign(raw)) =>
  request(app)
    .post("/api/v1/webhooks/stripe")
    .set("content-type", "application/json")
    .set("stripe-signature", signature)
    .send(raw);

describe("Stripe webhook signature", () => {
  it("returns PAYMENTS_UNCONFIGURED and writes nothing without a webhook secret", async () => {
    env.STRIPE_WEBHOOK_SECRET = undefined;
    const res = await deliver(invoiceEvent("evt_1"));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("PAYMENTS_UNCONFIGURED");
    expect(await ProcessorEvent.countDocuments()).toBe(0);
  });
  it("rejects missing, wrong-secret, tampered and stale signatures", async () => {
    const raw = invoiceEvent("evt_1");
    const cases = [
      await request(app)
        .post("/api/v1/webhooks/stripe")
        .set("content-type", "application/json")
        .send(raw),
      await deliver(raw, sign(raw, now(), "whsec_wrong")),
      await deliver(raw.replace("30000", "1"), sign(raw)),
      await deliver(raw, sign(raw, now() - 301)),
      await deliver(raw, "t=abc,v1=zz"),
    ];
    for (const res of cases) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_SIGNATURE");
    }
    expect(await Invoice.countDocuments()).toBe(0);
    expect(await ProcessorEvent.countDocuments()).toBe(0);
  });
  it("accepts any matching v1 signature among several", () => {
    const raw = "{}";
    const t = 1_800_000_000;
    const good = sign(raw, t).split("v1=")[1];
    const header = `t=${t},v1=${"0".repeat(64)},v1=${good}`;
    expect(() => verifyStripeSignature(raw, header, SECRET, t)).not.toThrow();
    expect(() => verifyStripeSignature(raw, header, SECRET, t + 10_000)).toThrow();
  });
});

describe("Stripe webhook effects and idempotency", () => {
  it("records a paid invoice once per event id, with a system audit row", async () => {
    const raw = invoiceEvent("evt_paid");
    const first = await deliver(raw);
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ received: true, duplicate: false });
    const invoice = await Invoice.findOne({ processorInvoiceId: "in_synthetic" }).lean();
    expect(invoice).toMatchObject({ amountCents: 30000, status: "paid", organizationId: ORG });
    expect(String(invoice?.memberId)).toBe(String(member._id));
    const replay = await deliver(invoiceEvent("evt_paid", { amount_paid: 1, status: "void" }));
    expect(replay.body.data).toEqual({ received: true, duplicate: true });
    expect(await Invoice.findOne().lean()).toMatchObject({ amountCents: 30000, status: "paid" });
    expect(await ProcessorEvent.countDocuments({ eventId: "evt_paid" })).toBe(1);
    expect(
      await AuditEvent.countDocuments({ actorId: "system:stripe", targetType: "Invoice" })
    ).toBe(1);
  });
  it("applies concurrent duplicate deliveries exactly once", async () => {
    const raw = invoiceEvent("evt_race");
    const results = await Promise.all([deliver(raw), deliver(raw), deliver(raw)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.data.duplicate === false)).toHaveLength(1);
    expect(await AuditEvent.countDocuments({ actorId: "system:stripe" })).toBe(1);
  });
  it("never lets an older event overwrite a newer invoice state", async () => {
    await deliver(invoiceEvent("evt_new", { status: "paid" }, now()));
    await deliver(
      JSON.stringify({
        ...JSON.parse(invoiceEvent("evt_old", { status: "open" }, now() - 60)),
        type: "invoice.finalized",
      })
    );
    expect((await Invoice.findOne().lean())?.status).toBe("paid");
  });
  it("marks a failed payment and cancels a deleted subscription's membership", async () => {
    await deliver(
      JSON.stringify({
        ...JSON.parse(invoiceEvent("evt_fail", { status: "open", amount_paid: 0 })),
        type: "invoice.payment_failed",
      })
    );
    expect((await Invoice.findOne().lean())?.status).toBe("failed");
    const planId = (
      await MembershipPlan.create({ organizationId: ORG, slug: "p", name: "P", brand: "aerwell" })
    )._id;
    const held = await MemberMembership.create({
      organizationId: ORG,
      memberId: member._id,
      planId,
      startedAt: new Date("2026-01-01"),
      processorSubscriptionId: "sub_synthetic",
    });
    const subscription = (id: string, type: string, status: string) =>
      JSON.stringify({
        id,
        type,
        created: now(),
        data: { object: { id: "sub_synthetic", customer: "cus_synthetic", status } },
      });
    await deliver(subscription("evt_sub_1", "customer.subscription.updated", "past_due"));
    expect((await MemberMembership.findById(held._id))?.status).toBe("past_due");
    await deliver(subscription("evt_sub_2", "customer.subscription.deleted", "canceled"));
    const cancelled = await MemberMembership.findById(held._id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelledAt).toBeTruthy();
  });
  it("records unknown customers and event types as ignored", async () => {
    const res = await deliver(invoiceEvent("evt_unknown", { customer: "cus_nobody" }));
    expect(res.status).toBe(200);
    const other = JSON.stringify({
      id: "evt_other",
      type: "charge.refunded",
      created: now(),
      data: { object: {} },
    });
    expect((await deliver(other)).status).toBe(200);
    expect(await ProcessorEvent.countDocuments({ outcome: "ignored" })).toBe(2);
    expect(await Invoice.countDocuments()).toBe(0);
  });
  it("rejects a signed body that is not a Stripe event", async () => {
    const raw = JSON.stringify({ hello: "world" });
    const res = await deliver(raw);
    expect(res.status).toBe(400);
    expect(await ProcessorEvent.countDocuments()).toBe(0);
  });
});
