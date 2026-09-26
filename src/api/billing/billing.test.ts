import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { createServer } from "../../server.js";
import { ORG, client, idOf, memberRow, staffWith } from "../../test/memberFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { Member, type MemberDocument } from "../member/member.model.js";
import { getBillingAdapter, setBillingAdapter } from "./billing.adapter.js";
import { Invoice, PaymentMethod } from "./billing.model.js";
import { createFakeBillingAdapter } from "./fake.adapter.js";
import { createStripeAdapter } from "./stripe.adapter.js";

let app: ReturnType<typeof createServer>;
let admin: ReturnType<typeof client>;
let member: MemberDocument;
beforeEach(async () => {
  app = createServer();
  admin = client(app, (await staffFixture(true)).accessToken);
  member = await memberRow({ firstName: "Card", lastName: "Holder" });
});
afterEach(() => {
  setBillingAdapter(null);
  vi.unstubAllGlobals();
});
const url = (suffix: string, id = idOf(member)) => `/members/${id}${suffix}`;
const card = { processorPaymentMethodId: "pm_fake_1", nameOnCard: "Card Holder" };

describe("payments unconfigured (no keys)", () => {
  it("says so explicitly and never pretends success", async () => {
    expect(getBillingAdapter().configured).toBe(false);
    expect((await admin.get("/billing/config")).body.data).toEqual({
      configured: false,
      publishableKey: null,
    });
    const setup = await admin.send("post", url("/payment-method/setup-intent"));
    expect(setup.status).toBe(503);
    expect(setup.body.code).toBe("PAYMENTS_UNCONFIGURED");
    const put = await admin.send("put", url("/payment-method"), card);
    expect(put.status).toBe(503);
    expect(put.body.code).toBe("PAYMENTS_UNCONFIGURED");
    expect(await PaymentMethod.countDocuments()).toBe(0);
    const read = await admin.get(url("/payment-method"));
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual({ paymentsConfigured: false, paymentMethod: null });
    expect((await Member.findById(member._id))?.processorCustomerId).toBeUndefined();
  });
});

describe("BILLING permission", () => {
  it("denies payment and invoice reads without BILLING, allows view-only reads", async () => {
    const physician = client(
      app,
      (await staffWith({ MEMBER_RECORDS: "edit", CLINICAL_NOTES: "edit" })).accessToken
    );
    expect((await physician.get(url("/payment-method"))).status).toBe(403);
    expect((await physician.get(url("/invoices"))).status).toBe(403);
    const frontDesk = client(
      app,
      (await staffWith({ MEMBER_RECORDS: "view", BILLING: "view" })).accessToken
    );
    expect((await frontDesk.get(url("/payment-method"))).status).toBe(200);
    expect((await frontDesk.get(url("/invoices"))).status).toBe(200);
    expect((await frontDesk.send("put", url("/payment-method"), card)).status).toBe(403);
    expect((await frontDesk.send("post", url("/payment-method/setup-intent"))).status).toBe(403);
    const billingOnly = client(app, (await staffWith({ BILLING: "edit" })).accessToken);
    expect((await billingOnly.get(url("/payment-method"))).status).toBe(403);
  });
});

describe("card on file with the in-memory fake", () => {
  it("creates one customer, a setup intent, and stores display fields only", async () => {
    const fake = createFakeBillingAdapter();
    setBillingAdapter(fake);
    const first = await admin.send("post", url("/payment-method/setup-intent"));
    expect(first.status).toBe(200);
    expect(first.body.data.clientSecret).toMatch(/^seti_fake_/);
    await admin.send("post", url("/payment-method/setup-intent"));
    expect(fake.customers.size).toBe(1);
    const customerId = (await Member.findById(member._id))?.processorCustomerId as string;
    fake.addCard(customerId, {
      id: "pm_fake_1",
      brand: "visa",
      last4: "4829",
      expMonth: 9,
      expYear: 2029,
    });
    const saved = await admin.send("put", url("/payment-method"), {
      ...card,
      billingAddress: {
        line1: "1 Synthetic St",
        city: "Las Vegas",
        state: "NV",
        postalCode: "89101",
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.paymentMethod).toMatchObject({
      brand: "visa",
      last4: "4829",
      expMonth: 9,
      expYear: 2029,
    });
    const stored = await PaymentMethod.findOne({ memberId: member._id }).lean();
    expect(Object.keys(stored ?? {})).not.toContain("number");
    expect(
      await AuditEvent.countDocuments({ targetType: "PaymentMethod", action: "updated" })
    ).toBe(1);
    const read = await admin.get(url("/payment-method"));
    expect(read.body.data.paymentMethod.billingAddress.city).toBe("Las Vegas");
    expect(await AuditEvent.countDocuments({ targetType: "PaymentMethod", action: "viewed" })).toBe(
      1
    );
  });
  it("refuses a payment method that belongs to another customer or has no card", async () => {
    const fake = createFakeBillingAdapter();
    setBillingAdapter(fake);
    await admin.send("post", url("/payment-method/setup-intent"));
    fake.addCard("cus_someone_else", {
      id: "pm_other",
      brand: "visa",
      last4: "1111",
      expMonth: 1,
      expYear: 2030,
    });
    const res = await admin.send("put", url("/payment-method"), {
      ...card,
      processorPaymentMethodId: "pm_other",
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PAYMENT_METHOD_MISMATCH");
    expect(await PaymentMethod.countDocuments()).toBe(0);
    expect(
      (
        await admin.send("put", url("/payment-method"), {
          ...card,
          processorPaymentMethodId: "4242424242424242",
        })
      ).status
    ).toBe(400);
  });
});

describe("invoices", () => {
  it("lists only this member's invoices newest first, paginated, and resolves the hosted URL", async () => {
    const other = await memberRow();
    const invoice = (memberId: unknown, n: number) => ({
      organizationId: ORG,
      memberId,
      processorInvoiceId: `in_${n}`,
      description: `Invoice ${n}`,
      amountCents: 30000,
      status: "paid",
      issuedAt: new Date(Date.UTC(2026, n, 1)),
      hostedInvoiceUrl: `https://invoice.example.invalid/${n}`,
      lastEventAt: new Date(),
    });
    await Invoice.create([
      invoice(member._id, 1),
      invoice(member._id, 3),
      invoice(member._id, 2),
      invoice(other._id, 4),
    ]);
    const page = await admin.get(url("/invoices?limit=2"));
    expect(page.body.data.items.map((i: { description: string }) => i.description)).toEqual([
      "Invoice 3",
      "Invoice 2",
    ]);
    expect(page.body.data.pagination).toMatchObject({ total: 3, totalPages: 2 });
    const target = page.body.data.items[0]._id;
    const pdf = await admin.get(`/invoices/${target}/pdf`);
    expect(pdf.body.data).toEqual({ url: "https://invoice.example.invalid/3" });
    const foreign = await Invoice.findOne({ memberId: other._id });
    const own = await staffWith({ MEMBER_RECORDS: "view", BILLING: "view" }, "own");
    await Member.updateOne(
      { _id: member._id },
      { $set: { assignedClinicianIds: [own.staff._id] } }
    );
    const ownApi = client(app, own.accessToken);
    expect((await ownApi.get(`/invoices/${idOf(foreign as never)}/pdf`)).status).toBe(404);
    expect((await ownApi.get(`/invoices/${target}/pdf`)).status).toBe(200);
    expect(await AuditEvent.countDocuments({ targetType: "Invoice", action: "viewed" })).toBe(2);
  });
});

describe("Stripe adapter (fetch mocked; no network)", () => {
  it("form-encodes requests with the secret, an idempotency key and no member PHI", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init: RequestInit) => {
        calls.push({ url: u, init });
        const body = u.includes("/customers")
          ? { id: "cus_1" }
          : u.includes("/setup_intents")
            ? { id: "seti_1", client_secret: "seti_1_secret" }
            : {
                id: "pm_1",
                customer: "cus_1",
                card: { brand: "visa", last4: "4242", exp_month: 1, exp_year: 2030 },
              };
        return new Response(JSON.stringify(body), { status: 200 });
      })
    );
    const adapter = createStripeAdapter("sk_test_synthetic", "pk_test_synthetic");
    expect(await adapter.createCustomer({ memberId: "m1", organizationId: ORG })).toBe("cus_1");
    expect(await adapter.createSetupIntent("cus_1")).toEqual({
      id: "seti_1",
      clientSecret: "seti_1_secret",
    });
    expect(await adapter.retrievePaymentMethod("pm_1")).toEqual({
      id: "pm_1",
      customerId: "cus_1",
      brand: "visa",
      last4: "4242",
      expMonth: 1,
      expYear: 2030,
    });
    const [customer, setup, pm] = calls;
    expect(customer?.url).toBe("https://api.stripe.com/v1/customers");
    const headers = new Headers(customer?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk_test_synthetic");
    expect(headers.get("idempotency-key")).toBe("aerwell-customer-m1");
    expect(String(customer?.init.body)).toBe(
      "metadata%5BmemberId%5D=m1&metadata%5BorganizationId%5D=org-test"
    );
    expect(String(setup?.init.body)).toContain("usage=off_session");
    expect(pm?.url).toBe("https://api.stripe.com/v1/payment_methods/pm_1");
    expect(pm?.init.method).toBe("GET");
  });
  it("maps a processor error to PAYMENT_FAILED without leaking the processor message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "raw detail" } }), { status: 402 })
      )
    );
    const failure = await createStripeAdapter("sk_test_synthetic", "pk")
      .createSetupIntent("cus_1")
      .catch((e) => e);
    expect(failure).toMatchObject({ statusCode: 502, code: "PAYMENT_FAILED" });
    expect(failure.message).not.toContain("raw detail");
  });
  it("is selected only when both keys are present", () => {
    env.STRIPE_SECRET_KEY = "sk_test_synthetic";
    expect(getBillingAdapter().configured).toBe(false);
    env.STRIPE_PUBLISHABLE_KEY = "pk_test_synthetic";
    expect(getBillingAdapter().configured).toBe(true);
    expect(getBillingAdapter().publishableKey).toBe("pk_test_synthetic");
    env.STRIPE_SECRET_KEY = undefined;
    env.STRIPE_PUBLISHABLE_KEY = undefined;
  });
});
