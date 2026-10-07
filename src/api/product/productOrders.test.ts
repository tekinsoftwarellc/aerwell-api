import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { pinClock } from "../../test/appointmentFixture.js";
import { memberRow } from "../../test/memberFixture.js";
import {
  ACCOUNT,
  alfredClient,
  alfredToken,
  installAlfredKeys,
  removeAlfredKeys,
} from "../../test/partnerFixture.js";
import { ADDRESS, type ProductWorld, productWorld } from "../../test/productFixture.js";
import { app } from "../../test/scheduleFixture.js";
import { PartnerOutbox } from "../alfred-partner/outbox/partnerOutbox.model.js";
import { SupplementProduct } from "../supplement/supplement.js";
import { ProductOrder } from "./productOrder.model.js";
import { UNPAID_RELEASE_MS, releaseUnpaidOrders } from "./productOrder.service.js";

beforeEach(() => {
  pinClock();
  installAlfredKeys();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  removeAlfredKeys();
  env.PRODUCT_SHIPPING_FLAT_CENTS = 0;
});

const stockOf = async (id: unknown) => (await SupplementProduct.findById(id).lean())?.stock;
const ref = (sku: string) => `prod_${sku}`;
/** A prescribed product and a placed order for `quantity` of it. */
async function placed(w: ProductWorld, quantity = 2, stock = 10) {
  const product = await w.product({ stock });
  await w.prescribe(product._id);
  const res = await w.place([{ itemRef: ref(product.sku), quantity }]);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { product, orderRef: res.body.data.orderRef as string };
}
const outbox = (type: string) => PartnerOutbox.find({ type }).sort({ _id: 1 }).lean();

describe("POST /orders", () => {
  it("prices from the catalog, adds the configured flat shipping and no tax, reserves stock, and never echoes the address", async () => {
    env.PRODUCT_SHIPPING_FLAT_CENTS = 700;
    const w = await productWorld();
    const product = await w.product({ stock: 10, priceCents: 3400 });
    await w.prescribe(product._id);
    const res = await w.place([{ itemRef: ref(product.sku), quantity: 2 }]);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: "placed",
      items: [
        {
          itemRef: ref(product.sku),
          quantity: 2,
          unitPriceCents: 3400,
          lineTotalCents: 6800,
          title: product.name,
        },
      ],
      totals: {
        subtotalCents: 6800,
        shippingCents: 700,
        taxCents: 0,
        totalCents: 7500,
        currency: "usd",
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("ADDRESS-SENTINEL");
    expect(await stockOf(product._id)).toBe(8);
    const stored = await ProductOrder.findById(res.body.data.orderRef)
      .select("+shippingAddress")
      .lean();
    expect(stored?.shippingAddress?.line1).toBe(ADDRESS.line1);
    // Never returned by default: a list or lookup cannot leak it by accident.
    expect(
      (await ProductOrder.findById(res.body.data.orderRef).lean())?.shippingAddress
    ).toBeUndefined();
  });

  it("a product the clinician did not prescribe to this member is 409 MEMBERSHIP_REQUIRED and takes no stock", async () => {
    const w = await productWorld();
    const product = await w.product();
    const other = await memberRow({ status: "active" });
    await w.prescribe(product._id, other._id);
    const res = await w.place([{ itemRef: ref(product.sku), quantity: 1 }]);
    expect([res.status, res.body.data.code]).toEqual([409, "MEMBERSHIP_REQUIRED"]);
    expect(await stockOf(product._id)).toBe(10);
    expect(await ProductOrder.countDocuments()).toBe(0);
  });

  it("an unknown, unpublished or retired item is 404", async () => {
    const w = await productWorld();
    const hidden = await w.product({ forSale: false });
    const retired = await w.product({ active: false });
    await w.prescribe(hidden._id);
    await w.prescribe(retired._id);
    for (const itemRef of ["prod_nope", ref(hidden.sku), ref(retired.sku), "dexa-scan"])
      expect((await w.place([{ itemRef, quantity: 1 }])).status, itemRef).toBe(404);
  });

  it("ships to the United States only: any other country is 409 SHIPPING_UNAVAILABLE", async () => {
    const w = await productWorld();
    const product = await w.product();
    await w.prescribe(product._id);
    const res = await w.place([{ itemRef: ref(product.sku), quantity: 1 }], {
      shippingAddress: { ...ADDRESS, country: "CA" },
    });
    expect([res.status, res.body.data.code]).toEqual([409, "SHIPPING_UNAVAILABLE"]);
    expect(await stockOf(product._id)).toBe(10);
    const lower = await w.place([{ itemRef: ref(product.sku), quantity: 1 }], {
      shippingAddress: { ...ADDRESS, country: "us" },
    });
    expect(lower.status).toBe(201);
  });

  it("a short line is 409 OUT_OF_STOCK and rolls back the lines before it", async () => {
    const w = await productWorld();
    const plenty = await w.product({ stock: 5 });
    const scarce = await w.product({ stock: 1 });
    await w.prescribe(plenty._id);
    await w.prescribe(scarce._id);
    const res = await w.place([
      { itemRef: ref(plenty.sku), quantity: 3 },
      { itemRef: ref(scarce.sku), quantity: 2 },
    ]);
    expect([res.status, res.body.data.code]).toEqual([409, "OUT_OF_STOCK"]);
    expect([await stockOf(plenty._id), await stockOf(scarce._id)]).toEqual([5, 1]);
    expect(await ProductOrder.countDocuments()).toBe(0);
  });

  it("two concurrent orders for the last unit: exactly one wins, stock never goes below zero", async () => {
    const w = await productWorld();
    const product = await w.product({ stock: 1 });
    await w.prescribe(product._id);
    const other = await memberRow({
      alfredAccountId: "6710bb4e2f9c1a0031d5e7b7",
      status: "active",
    });
    await w.prescribe(product._id, other._id);
    const itemRef = ref(product.sku);
    const [a, b] = await Promise.all([
      w.place([{ itemRef, quantity: 1 }]),
      w.place([{ itemRef, quantity: 1 }]),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)?.body.data.code).toBe("OUT_OF_STOCK");
    expect(await stockOf(product._id)).toBe(0);
    expect(await ProductOrder.countDocuments()).toBe(1);
  });

  it("the same Idempotency-Key replays the same order and reserves once", async () => {
    const w = await productWorld();
    const product = await w.product();
    await w.prescribe(product._id);
    const items = [{ itemRef: ref(product.sku), quantity: 2 }];
    const first = await w.place(items, {}, "same-key");
    const again = await w.place(items, {}, "same-key");
    expect(again.body.data.orderRef).toBe(first.body.data.orderRef);
    expect(await stockOf(product._id)).toBe(8);
  });

  it("refuses a body whose accountId is not the acting member", async () => {
    const w = await productWorld();
    const product = await w.product();
    await w.prescribe(product._id);
    const res = await w.place([{ itemRef: ref(product.sku), quantity: 1 }], {
      accountId: "6710bb4e2f9c1a0031d5e7b7",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /orders/{ref} and cancel", () => {
  it("reads the member's own order, 404 for anyone else's", async () => {
    const w = await productWorld();
    const { orderRef } = await placed(w);
    const own = await w.alfred.get(`/orders/${orderRef}`);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ orderRef, status: "placed" });
    expect(JSON.stringify(own.body)).not.toContain("ADDRESS-SENTINEL");
    await memberRow({ alfredAccountId: "6710bb4e2f9c1a0031d5e7b7", status: "active" });
    const stranger = alfredClient(app, alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7b7" }));
    expect((await stranger.get(`/orders/${orderRef}`)).status).toBe(404);
    expect((await w.alfred.get("/orders/not-an-id")).status).toBe(404);
  });

  it("cancel before payment returns the stock and owes nothing; a repeat answers the same", async () => {
    const w = await productWorld();
    const { product, orderRef } = await placed(w, 3);
    expect(await stockOf(product._id)).toBe(7);
    const res = await w.alfred.post(`/orders/${orderRef}/cancel`, { reason: "REASON-SENTINEL" });
    expect([res.status, res.body.data]).toEqual([200, { status: "cancelled", refundCents: 0 }]);
    expect(await stockOf(product._id)).toBe(10);
    const again = await w.alfred.post(`/orders/${orderRef}/cancel`, {});
    expect([again.status, again.body.data.status]).toEqual([200, "cancelled"]);
    expect(await stockOf(product._id)).toBe(10);
    // Alfred cancelled it itself: no event is owed back.
    expect(await outbox("order.cancelled")).toHaveLength(0);
  });

  it("cancel after payment owes the whole total back", async () => {
    const w = await productWorld();
    const { orderRef } = await placed(w, 1);
    await w.event("order.paid", orderRef, { amountCents: 3400 });
    const res = await w.alfred.post(`/orders/${orderRef}/cancel`, {});
    expect(res.body.data).toEqual({ status: "cancelled", refundCents: 3400 });
  });

  it("a shipped order cannot be cancelled: 409 ALREADY_SHIPPED", async () => {
    const w = await productWorld();
    const { product, orderRef } = await placed(w);
    await ProductOrder.updateOne({ _id: orderRef }, { $set: { status: "shipped" } });
    const res = await w.alfred.post(`/orders/${orderRef}/cancel`, {});
    expect([res.status, res.body.data.code]).toEqual([409, "ALREADY_SHIPPED"]);
    expect(await stockOf(product._id)).toBe(8);
  });
});

describe("inbound order.paid and order.refunded", () => {
  it("order.paid marks a placed order paid once; a replay and a second key change nothing", async () => {
    const w = await productWorld();
    const { orderRef } = await placed(w, 1);
    const paidAt = "2027-03-01T20:05:00.000Z";
    const body = { amountCents: 3400, paymentIntentId: "pi_first", paidAt };
    expect((await w.event("order.paid", orderRef, body, "k1")).body.data.status).toBe("received");
    const row = await ProductOrder.findById(orderRef).lean();
    expect(row).toMatchObject({ status: "paid", paidCents: 3400, paymentIntentId: "pi_first" });
    expect(row?.paidAt?.toISOString()).toBe(paidAt);
    expect((await w.event("order.paid", orderRef, body, "k1")).body.data.status).toBe("duplicate");
    await w.event(
      "order.paid",
      orderRef,
      { ...body, paymentIntentId: "pi_second", amountCents: 1 },
      "k2"
    );
    expect(await ProductOrder.findById(orderRef).lean()).toMatchObject({
      status: "paid",
      paidCents: 3400,
      paymentIntentId: "pi_first",
    });
  });

  it("an event naming another account's order, or an unknown one, changes nothing and still answers 202", async () => {
    const w = await productWorld();
    const { orderRef } = await placed(w, 1);
    const wrong = await w.org.post("/events", {
      idempotencyKey: "x1",
      type: "order.paid",
      occurredAt: new Date().toISOString(),
      accountId: "6710bb4e2f9c1a0031d5e7b7",
      resource: { kind: "order", ref: orderRef },
      payload: { kind: "purchase", ref: orderRef, amountCents: 3400 },
    });
    expect(wrong.status).toBe(202);
    expect((await w.event("order.paid", "0".repeat(24))).status).toBe(202);
    expect((await ProductOrder.findById(orderRef).lean())?.status).toBe("placed");
  });

  it("order.refunded adds each refund up, once per event, and moves a paid order to refunded", async () => {
    const w = await productWorld();
    const { orderRef } = await placed(w, 1);
    await w.event("order.paid", orderRef, { amountCents: 3400 });
    const refundedAt = "2027-03-02T10:00:00.000Z";
    await w.event("order.refunded", orderRef, { amountCents: 1000, refundedAt }, "r1");
    await w.event("order.refunded", orderRef, { amountCents: 1000, refundedAt }, "r1");
    await w.event(
      "order.refunded",
      orderRef,
      { amountCents: 2400, refundedAt: "2027-03-03T10:00:00.000Z" },
      "r2"
    );
    const row = await ProductOrder.findById(orderRef).lean();
    expect(row).toMatchObject({ status: "refunded", refundedCents: 3400 });
    expect(row?.refundedAt?.toISOString()).toBe(refundedAt);
  });

  it("an order.refunded after a cancel keeps the order cancelled", async () => {
    const w = await productWorld();
    const { orderRef } = await placed(w, 1);
    await w.event("order.paid", orderRef, { amountCents: 3400 });
    await w.alfred.post(`/orders/${orderRef}/cancel`, {});
    await w.event("order.refunded", orderRef, { amountCents: 3400 });
    expect(await ProductOrder.findById(orderRef).lean()).toMatchObject({
      status: "cancelled",
      refundedCents: 3400,
    });
  });

  it("a booking payment event still reaches bookings (no purchase kind)", async () => {
    const w = await productWorld();
    const { orderRef } = await placed(w, 1);
    const res = await w.org.post("/events", {
      idempotencyKey: "b1",
      type: "order.paid",
      occurredAt: new Date().toISOString(),
      accountId: ACCOUNT,
      resource: { kind: "order", ref: orderRef },
      payload: { kind: "booking", ref: orderRef, amountCents: 3400 },
    });
    expect(res.status).toBe(202);
    expect((await ProductOrder.findById(orderRef).lean())?.status).toBe("placed");
  });
});

describe("auto-release of unpaid orders", () => {
  const later = (ms: number) => new Date(Date.now() + ms);

  it("cancels an unpaid order older than 30 minutes, returns its stock and tells Alfred (system)", async () => {
    const w = await productWorld();
    const { product, orderRef } = await placed(w, 4);
    expect(await releaseUnpaidOrders(later(UNPAID_RELEASE_MS - 60_000))).toBe(0);
    expect(await stockOf(product._id)).toBe(6);
    expect(await releaseUnpaidOrders(later(UNPAID_RELEASE_MS + 60_000))).toBe(1);
    expect(await ProductOrder.findById(orderRef).lean()).toMatchObject({
      status: "cancelled",
      cancelledBy: "system",
      stockReleased: true,
    });
    expect(await stockOf(product._id)).toBe(10);
    const [event] = await outbox("order.cancelled");
    expect(event).toMatchObject({
      accountId: ACCOUNT,
      resource: { kind: "order", ref: orderRef },
      payload: { cancelledBy: "system", refundCents: 0, title: "Order cancelled" },
    });
    expect(typeof (event?.payload as { body: string }).body).toBe("string");
    // A second sweep finds nothing and gives nothing back twice.
    expect(await releaseUnpaidOrders(later(UNPAID_RELEASE_MS + 120_000))).toBe(0);
    expect(await stockOf(product._id)).toBe(10);
  });

  it("never touches a paid order, however old", async () => {
    const w = await productWorld();
    const { product, orderRef } = await placed(w, 1);
    await w.event("order.paid", orderRef, { amountCents: 3400 });
    expect(await releaseUnpaidOrders(later(UNPAID_RELEASE_MS * 10))).toBe(0);
    expect((await ProductOrder.findById(orderRef).lean())?.status).toBe("paid");
    expect(await stockOf(product._id)).toBe(9);
  });

  it("a charge that lands after the release is told back to Alfred as a full refund owed", async () => {
    const w = await productWorld();
    const { orderRef } = await placed(w, 1);
    await releaseUnpaidOrders(later(UNPAID_RELEASE_MS + 60_000));
    await w.event("order.paid", orderRef, { amountCents: 3400, paymentIntentId: "pi_late" });
    expect(await ProductOrder.findById(orderRef).lean()).toMatchObject({
      status: "cancelled",
      paidCents: 3400,
      cancelRefundCents: 3400,
    });
    const events = await outbox("order.cancelled");
    expect(events.map((e) => (e.payload as { refundCents: number }).refundCents)).toEqual([
      0, 3400,
    ]);
  });
});
