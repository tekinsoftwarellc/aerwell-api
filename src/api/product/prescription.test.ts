import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinClock } from "../../test/appointmentFixture.js";
import { memberRow } from "../../test/memberFixture.js";
import {
  ACCOUNT,
  alfredClient,
  installAlfredKeys,
  removeAlfredKeys,
} from "../../test/partnerFixture.js";
import { type ProductWorld, productWorld } from "../../test/productFixture.js";
import { app } from "../../test/scheduleFixture.js";
import { PartnerIdempotencyKey } from "../alfred-partner/partnerIdempotency.model.js";
import { SupplementOrder, SupplementProduct } from "../supplement/supplement.js";
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
});

const ref = (sku: string) => `prod_${sku}`;
const rx = async (id: unknown) => SupplementOrder.findOne({ productId: id }).lean();
const listed = async (sku: string) => {
  const res = await alfredClient(app).get(`/catalog?kind=products&accountId=${ACCOUNT}`);
  return (res.body.data.items as { partnerRef: string }[]).some((i) => i.partnerRef === ref(sku));
};
async function prescribed(w: ProductWorld, qty: number) {
  const product = await w.product();
  await w.prescribe(product._id, w.member._id, qty);
  return product;
}
const order = (w: ProductWorld, sku: string, quantity: number) =>
  w.place([{ itemRef: ref(sku), quantity }]);

describe("prescription covers one purchase up to its quantity", () => {
  it("refuses more than the prescribed quantity, and takes nothing for the refusal", async () => {
    const w = await productWorld();
    const p = await prescribed(w, 2);
    const over = await order(w, p.sku, 3);
    expect([over.status, over.body.data.code]).toEqual([409, "MEMBERSHIP_REQUIRED"]);
    expect(over.body.message).toMatch(/smaller quantity/);
    expect((await SupplementProduct.findById(p._id).lean())?.stock).toBe(10);
    expect((await rx(p._id))?.claimedByOrderId).toBeNull();
    expect((await order(w, p.sku, 2)).status).toBe(201);
  });

  it("is used up by one purchase: a second order, and the member listing, no longer see it", async () => {
    const w = await productWorld();
    const p = await prescribed(w, 5);
    expect(await listed(p.sku)).toBe(true);
    expect((await order(w, p.sku, 1)).status).toBe(201);
    const again = await order(w, p.sku, 1);
    expect([again.status, again.body.data.code]).toEqual([409, "MEMBERSHIP_REQUIRED"]);
    expect(again.body.message).toMatch(/already been used/);
    expect(await listed(p.sku)).toBe(false);
  });

  it("a second prescription allows a second purchase, and the tightest fit is used first", async () => {
    const w = await productWorld();
    const p = await prescribed(w, 5);
    await w.prescribe(p._id, w.member._id, 1);
    expect((await order(w, p.sku, 1)).status).toBe(201);
    const left = await SupplementOrder.find({ productId: p._id, claimedByOrderId: null }).lean();
    expect(left.map((r) => r.qty)).toEqual([5]);
    expect((await order(w, p.sku, 5)).status).toBe(201);
  });

  it("an unpaid cancel, the 30-minute release and an unshipped full refund give it back; payment consumes it", async () => {
    const w = await productWorld();
    const p = await prescribed(w, 2);
    const first = (await order(w, p.sku, 2)).body.data.orderRef as string;
    expect((await rx(p._id))?.claimedByOrderId).toBeTruthy();
    await w.alfred.post(`/orders/${first}/cancel`, {});
    expect(await listed(p.sku)).toBe(true);

    const second = (await order(w, p.sku, 2)).body.data.orderRef as string;
    expect(await releaseUnpaidOrders(new Date(Date.now() + UNPAID_RELEASE_MS + 1000))).toBe(1);
    expect(await listed(p.sku)).toBe(true);

    const third = (await order(w, p.sku, 2)).body.data.orderRef as string;
    expect((await rx(p._id))?.consumedAt).toBeNull();
    await w.event("order.paid", third, { amountCents: 6800 });
    expect((await rx(p._id))?.consumedAt).toBeTruthy();
    expect(String((await rx(p._id))?.claimedByOrderId)).toBe(third);
    expect((await order(w, p.sku, 1)).status).toBe(409);

    await w.event("order.refunded", third, { amountCents: 100 }, "part");
    expect((await rx(p._id))?.consumedAt).toBeTruthy();
    await w.event("order.refunded", third, { amountCents: 6700 }, "rest");
    expect(await rx(p._id)).toMatchObject({ claimedByOrderId: null, consumedAt: null });
    expect((await ProductOrder.findById(second).lean())?.status).toBe("cancelled");
  });

  it("a shipped order keeps its prescription consumed through a refund", async () => {
    const w = await productWorld();
    const p = await prescribed(w, 1);
    const orderRef = (await order(w, p.sku, 1)).body.data.orderRef as string;
    await w.event("order.paid", orderRef, { amountCents: 3400 });
    await ProductOrder.updateOne({ _id: orderRef }, { $set: { status: "shipped" } });
    await w.event("order.refunded", orderRef, { amountCents: 3400 });
    expect((await rx(p._id))?.consumedAt).toBeTruthy();
    expect(await listed(p.sku)).toBe(false);
  });

  it("an order Alfred already charged consumes the prescription at once", async () => {
    const w = await productWorld();
    const p = await prescribed(w, 1);
    const res = await w.place([{ itemRef: ref(p.sku), quantity: 1 }], {
      payment: { status: "paid", paymentIntentId: "pi_x", amountCents: 3400, currency: "usd" },
    });
    expect(res.status).toBe(201);
    expect((await rx(p._id))?.consumedAt).toBeTruthy();
  });

  it("a multi-line order that fails on a later line leaves every prescription free", async () => {
    const w = await productWorld();
    const a = await prescribed(w, 1);
    const b = await w.product();
    const res = await w.place([
      { itemRef: ref(a.sku), quantity: 1 },
      { itemRef: ref(b.sku), quantity: 1 },
    ]);
    expect(res.status).toBe(409);
    expect((await rx(a._id))?.claimedByOrderId).toBeNull();
  });

  it("two concurrent orders for one prescription: exactly one wins, with plenty of stock", async () => {
    const w = await productWorld();
    const p = await prescribed(w, 1);
    const results = await Promise.all([order(w, p.sku, 1), order(w, p.sku, 1), order(w, p.sku, 1)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await ProductOrder.countDocuments()).toBe(1);
    expect((await SupplementProduct.findById(p._id).lean())?.stock).toBe(9);
  });

  it("another member's prescription is not usable", async () => {
    const w = await productWorld();
    const p = await w.product();
    const other = await memberRow({
      alfredAccountId: "6710bb4e2f9c1a0031d5e7b7",
      status: "active",
    });
    await w.prescribe(p._id, other._id, 3);
    const none = await order(w, p.sku, 1);
    expect(none.status).toBe(409);
    expect(none.body.message).toMatch(/none is on file/);
  });

  it("a late payment on a released order leaves the prescription a newer order holds untouched", async () => {
    const w = await productWorld();
    const p = await prescribed(w, 1);
    const old = (await order(w, p.sku, 1)).body.data.orderRef as string;
    await releaseUnpaidOrders(new Date(Date.now() + UNPAID_RELEASE_MS + 1000));
    const fresh = (await order(w, p.sku, 1)).body.data.orderRef as string;
    await w.event("order.paid", old, { amountCents: 3400 });
    expect(await rx(p._id)).toMatchObject({ consumedAt: null });
    expect(String((await rx(p._id))?.claimedByOrderId)).toBe(fresh);
  });

  it("cancelling a paid or prepaid order before shipping frees the prescription", async () => {
    const w = await productWorld();
    const p = await prescribed(w, 1);
    const res = await w.place([{ itemRef: ref(p.sku), quantity: 1 }], {
      payment: { status: "paid", paymentIntentId: "pi_y", amountCents: 3400, currency: "usd" },
    });
    await w.alfred.post(`/orders/${res.body.data.orderRef}/cancel`, {});
    expect(await rx(p._id)).toMatchObject({ claimedByOrderId: null, consumedAt: null });
  });

  it("replaying a placement whose stored outcome was lost returns the first order and keeps its prescription", async () => {
    const w = await productWorld();
    const p = await prescribed(w, 1);
    const first = await w.place(
      [{ itemRef: ref(p.sku), quantity: 1 }],
      {},
      "11111111-1111-4111-8111-111111111111"
    );
    await PartnerIdempotencyKey.deleteMany({});
    const replay = await w.place(
      [{ itemRef: ref(p.sku), quantity: 1 }],
      {},
      "11111111-1111-4111-8111-111111111111"
    );
    expect([replay.status, replay.body.data.orderRef]).toEqual([201, first.body.data.orderRef]);
    expect(await ProductOrder.countDocuments()).toBe(1);
  });
});
