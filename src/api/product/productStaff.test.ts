import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinClock } from "../../test/appointmentFixture.js";
import { client, idOf, staffWith } from "../../test/memberFixture.js";
import {
  ACCOUNT,
  alfredClient,
  alfredToken,
  installAlfredKeys,
  removeAlfredKeys,
} from "../../test/partnerFixture.js";
import { PAID, partnerWorld } from "../../test/partnerWorld.js";
import { type ProductWorld, productWorld } from "../../test/productFixture.js";
import { app } from "../../test/scheduleFixture.js";
import { PartnerOutbox } from "../alfred-partner/outbox/partnerOutbox.model.js";
import { SupplementProduct } from "../supplement/supplement.js";
import { publishProductChange, republishProducts } from "./productCatalog.js";
import { ProductOrder } from "./productOrder.model.js";

beforeEach(() => {
  pinClock();
  installAlfredKeys();
});
afterEach(() => {
  vi.useRealTimers();
  removeAlfredKeys();
});

const ref = (sku: string) => `prod_${sku}`;
const outbox = (type: string) => PartnerOutbox.find({ type }).sort({ _id: 1 }).lean();
async function staffs() {
  const catalog = await staffWith({ SERVICES: "edit" });
  const fulfil = await staffWith({ BILLING: "edit" });
  return {
    catalog: client(app, catalog.accessToken),
    fulfil: client(app, fulfil.accessToken),
    catalogFixture: catalog,
    fulfilFixture: fulfil,
  };
}
async function paidOrder(w: ProductWorld) {
  const product = await w.product();
  await w.prescribe(product._id);
  const res = await w.place([{ itemRef: ref(product.sku), quantity: 1 }]);
  const orderRef = res.body.data.orderRef as string;
  await w.event("order.paid", orderRef, { amountCents: 3400 });
  return { product, orderRef };
}

describe("staff product catalog", () => {
  it("creates, lists, edits and retires a product; a duplicate SKU is 409; stock is a stocktake", async () => {
    const s = await staffs();
    const created = await s.catalog.send("post", "/products", {
      sku: "magnesium-demo",
      name: "Magnesium demo",
      priceCents: 2600,
      stock: 5,
      forSale: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      partnerRef: "prod_magnesium-demo",
      stock: 5,
      active: true,
    });
    const dup = await s.catalog.send("post", "/products", {
      sku: "magnesium-demo",
      name: "x",
      priceCents: 1,
    });
    expect([dup.status, dup.body.code]).toEqual([409, "SKU_EXISTS"]);
    const bad = await s.catalog.send("post", "/products", {
      sku: "Bad SKU",
      name: "x",
      priceCents: 1,
    });
    expect(bad.status).toBe(400);
    const patched = await s.catalog.send("patch", `/products/${created.body.data.id}`, {
      stock: 9,
      priceCents: 2700,
    });
    expect(patched.body.data).toMatchObject({ stock: 9, priceCents: 2700 });
    expect(
      (await s.catalog.send("patch", `/products/${created.body.data.id}`, { sku: "new" })).status
    ).toBe(400);
    const list = await s.catalog.get("/products");
    expect(list.body.data.items.map((p: { sku: string }) => p.sku)).toContain("magnesium-demo");
    await s.catalog.send("patch", `/products/${created.body.data.id}`, { active: false });
    expect((await s.catalog.get("/products")).body.data.items[0].active).toBe(false);
  });

  it("is guarded: BILLING staff cannot edit the catalog and SERVICES staff cannot read orders", async () => {
    const s = await staffs();
    expect(
      (await s.fulfil.send("post", "/products", { sku: "a", name: "a", priceCents: 1 })).status
    ).toBe(403);
    expect((await s.catalog.get("/product-orders")).status).toBe(403);
    expect(
      (
        await s.catalog.send("post", `/product-orders/${"0".repeat(24)}/ship`, {
          carrier: "UPS",
          number: "1",
        })
      ).status
    ).toBe(403);
  });

  it("publishes a product change to Alfred as catalog.upserted with kind products", async () => {
    const s = await staffs();
    const created = await s.catalog.send("post", "/products", {
      sku: "omega-demo",
      name: "Omega demo",
      priceCents: 3800,
      stock: 4,
      forSale: true,
    });
    const [event] = await outbox("catalog.upserted");
    expect(event?.resource).toEqual({ kind: "catalog_item", ref: "prod_omega-demo" });
    expect(event?.payload).toMatchObject({
      partnerRef: "prod_omega-demo",
      kind: "products",
      status: "active",
      pricing: [{ mode: "one_time", amountCents: 3800 }],
      fulfilment: "standard",
    });
    expect(JSON.stringify(event?.payload)).not.toContain("stock");
    vi.setSystemTime(Date.now() + 5000);
    await s.catalog.send("patch", `/products/${created.body.data.id}`, { forSale: false });
    expect((await outbox("catalog.upserted")).at(-1)?.payload).toMatchObject({
      status: "inactive",
    });
  });
});

describe("republishProducts", () => {
  it("queues one catalog.upserted per product, per_member, for that org only", async () => {
    const mk = (organizationId: string, sku: string) =>
      SupplementProduct.create({
        organizationId,
        sku,
        name: sku,
        priceCents: 100,
        stock: 1,
        forSale: true,
      });
    await mk("org-test", "one");
    await mk("org-test", "two");
    await mk("org-other", "three");
    // Each product was already published once, as on a live database.
    for (const sku of ["one", "two"]) {
      const row = await SupplementProduct.findOne({ sku }).lean();
      await publishProductChange("org-test", row?._id);
    }
    expect(await outbox("catalog.upserted")).toHaveLength(2);
    vi.setSystemTime(Date.now() + 5000);
    expect(await republishProducts("org-test")).toBe(2);
    const events = await outbox("catalog.upserted");
    expect(events).toHaveLength(4);
    const resent = events.slice(2);
    expect(resent.map((e) => e.resource.ref).sort()).toEqual(["prod_one", "prod_two"]);
    expect(
      resent.every((e) => (e.payload as { visibility: string }).visibility === "per_member")
    ).toBe(true);
    // Same version as before: Alfred applies an equal version.
    const versions = (rows: typeof events) =>
      rows.map((e) => (e.payload as { version: number }).version).sort();
    expect(versions(resent)).toEqual(versions(events.slice(0, 2)));
  });
});

describe("catalog pull carries products", () => {
  it("kind=products lists only sellable products; with no kind it merges with services; an accountId narrows to prescribed", async () => {
    const w = await partnerWorld();
    const mine = await SupplementProduct.create({
      organizationId: "org-test",
      sku: "mine",
      name: "Mine",
      priceCents: 100,
      stock: 1,
      forSale: true,
    });
    await SupplementProduct.create({
      organizationId: "org-test",
      sku: "unsold",
      name: "Unsold",
      priceCents: 100,
      stock: 1,
      forSale: false,
    });
    await SupplementProduct.create({
      organizationId: "org-test",
      sku: "other",
      name: "Other",
      priceCents: 100,
      stock: 1,
      forSale: true,
    });
    const pw = await productWorld(w.aMember);
    await pw.prescribe(mine._id);
    const org = alfredClient(app, alfredToken({ accountId: null }));
    const products = await org.get("/catalog?kind=products");
    expect(
      products.body.data.items.map((i: { partnerRef: string }) => i.partnerRef).sort()
    ).toEqual(["prod_mine", "prod_other"]);
    expect(products.body.data.items[0]).toMatchObject({
      kind: "products",
      fulfilment: "standard",
      visibility: "per_member",
      locations: [],
    });
    const services = await org.get("/catalog?kind=services");
    expect(services.body.data.items.every((i: { kind: string }) => i.kind === "services")).toBe(
      true
    );
    const all = await org.get("/catalog?limit=200");
    const kinds = new Set(all.body.data.items.map((i: { kind: string }) => i.kind));
    expect([...kinds].sort()).toEqual(["products", "services"]);
    const personal = await alfredClient(app).get(`/catalog?kind=products&accountId=${ACCOUNT}`);
    expect(personal.body.data.items.map((i: { partnerRef: string }) => i.partnerRef)).toEqual([
      "prod_mine",
    ]);
    // The prescription never touches the product row, so a member pull ignores the watermark.
    const future = encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString());
    const since = await alfredClient(app).get(
      `/catalog?kind=products&accountId=${ACCOUNT}&updatedSince=${future}`
    );
    expect(since.body.data.items.map((i: { partnerRef: string }) => i.partnerRef)).toEqual([
      "prod_mine",
    ]);
    // One keyset across both collections: paging by 1 sees every item once, in order.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await org.get(`/catalog?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.body.data.items.map((i: { partnerRef: string }) => i.partnerRef));
      cursor = page.body.data.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(["prod_mine", "prod_other"]));
    expect(seen).toHaveLength(all.body.data.items.length);
  });

  it("GET /catalog/{ref} reads a product live; an unsold one is 404", async () => {
    await partnerWorld();
    await SupplementProduct.create({
      organizationId: "org-test",
      sku: "live",
      name: "Live",
      priceCents: 500,
      stock: 0,
      forSale: true,
    });
    await SupplementProduct.create({
      organizationId: "org-test",
      sku: "off",
      name: "Off",
      priceCents: 500,
      stock: 0,
      forSale: false,
    });
    const org = alfredClient(app, alfredToken({ accountId: null }));
    expect((await org.get("/catalog/prod_live")).body.data).toMatchObject({
      partnerRef: "prod_live",
      kind: "products",
    });
    expect((await org.get("/catalog/prod_off")).status).toBe(404);
  });
});

describe("staff fulfilment", () => {
  it("ships a paid order with tracking, queues order.shipped, and a repeat is 409 ALREADY_SHIPPED", async () => {
    const w = await productWorld();
    const s = await staffs();
    const { orderRef } = await paidOrder(w);
    const tracking = {
      carrier: "UPS",
      number: "1Z-DEMO-1",
      url: "https://www.ups.com/track?tracknum=1Z-DEMO-1",
    };
    const shipped = await s.fulfil.send("post", `/product-orders/${orderRef}/ship`, tracking);
    expect(shipped.status, JSON.stringify(shipped.body)).toBe(200);
    expect(shipped.body.data).toMatchObject({ status: "shipped", tracking });
    const [event] = await outbox("order.shipped");
    expect(event).toMatchObject({ accountId: ACCOUNT, resource: { kind: "order", ref: orderRef } });
    expect(event?.payload).toMatchObject({ orderRef, status: "shipped", tracking });
    expect(JSON.stringify(event)).not.toContain("ADDRESS-SENTINEL");
    const again = await s.fulfil.send("post", `/product-orders/${orderRef}/ship`, tracking);
    expect([again.status, again.body.code]).toEqual([409, "ALREADY_SHIPPED"]);
    expect(await outbox("order.shipped")).toHaveLength(1);
    const live = await w.alfred.get(`/orders/${orderRef}`);
    expect(live.body.data).toMatchObject({ status: "shipped", tracking });
    const cancel = await w.alfred.post(`/orders/${orderRef}/cancel`, {});
    expect([cancel.status, cancel.body.data.code]).toEqual([409, "ALREADY_SHIPPED"]);
    expect((await s.fulfil.send("post", `/product-orders/${orderRef}/cancel`, {})).status).toBe(
      409
    );
  });

  it("an unpaid order cannot be shipped: 409 ORDER_NOT_PAID", async () => {
    const w = await productWorld();
    const s = await staffs();
    const product = await w.product();
    await w.prescribe(product._id);
    const res = await w.place([{ itemRef: ref(product.sku), quantity: 1 }]);
    const ship = await s.fulfil.send("post", `/product-orders/${res.body.data.orderRef}/ship`, {
      carrier: "UPS",
      number: "1",
    });
    expect([ship.status, ship.body.code]).toEqual([409, "ORDER_NOT_PAID"]);
    expect(await outbox("order.shipped")).toHaveLength(0);
  });

  it("delivers a shipped order and queues order.delivered; delivering an unshipped one is 409", async () => {
    const w = await productWorld();
    const s = await staffs();
    const { orderRef } = await paidOrder(w);
    expect((await s.fulfil.send("post", `/product-orders/${orderRef}/deliver`, {})).status).toBe(
      409
    );
    await s.fulfil.send("post", `/product-orders/${orderRef}/ship`, {
      carrier: "UPS",
      number: "1",
    });
    const done = await s.fulfil.send("post", `/product-orders/${orderRef}/deliver`, {});
    expect(done.body.data.status).toBe("delivered");
    expect((await outbox("order.delivered"))[0]?.payload).toMatchObject({
      orderRef,
      status: "delivered",
    });
    expect((await s.fulfil.send("post", `/product-orders/${orderRef}/deliver`, {})).status).toBe(
      200
    );
    expect(await outbox("order.delivered")).toHaveLength(1);
  });

  it("staff cancel of a paid order returns the stock, owes the full total and queues order.cancelled with title and body", async () => {
    const w = await productWorld();
    const s = await staffs();
    const { product, orderRef } = await paidOrder(w);
    expect((await SupplementProduct.findById(product._id).lean())?.stock).toBe(9);
    const res = await s.fulfil.send("post", `/product-orders/${orderRef}/cancel`, {});
    expect(res.body.data.status).toBe("cancelled");
    expect((await SupplementProduct.findById(product._id).lean())?.stock).toBe(10);
    const [event] = await outbox("order.cancelled");
    expect(event?.payload).toMatchObject({
      orderRef,
      status: "cancelled",
      cancelledBy: "staff",
      refundCents: 3400,
      title: "Order cancelled",
      body: "Your order was cancelled and refunded.",
    });
    expect(JSON.stringify(event)).not.toContain(product.name);
    expect((await s.fulfil.send("post", `/product-orders/${orderRef}/cancel`, {})).status).toBe(
      200
    );
    expect(await outbox("order.cancelled")).toHaveLength(1);
  });

  it("lists orders for fulfilment with the address, member name and an audit row", async () => {
    const w = await productWorld();
    const s = await staffs();
    const { orderRef } = await paidOrder(w);
    const list = await s.fulfil.get("/product-orders?status=paid");
    expect(list.status).toBe(200);
    expect(list.body.data.items[0]).toMatchObject({
      id: orderRef,
      status: "paid",
      memberId: idOf(w.member),
      shippingAddress: { line1: expect.stringContaining("ADDRESS-SENTINEL"), country: "US" },
    });
    expect(list.body.data.items[0].memberName).toContain("First");
    expect((await s.fulfil.get("/product-orders?status=shipped")).body.data.items).toHaveLength(0);
    const { AuditEvent } = await import("../audit/audit.js");
    expect(
      await AuditEvent.countDocuments({ action: "listed", targetType: "ProductOrder" })
    ).toBeGreaterThan(0);
  });
});

describe("GET /orders stream", () => {
  it("returns purchases with totals next to bookings, one keyset across both, never the address", async () => {
    const w = await partnerWorld();
    const booked = await w.book("dexa-scan", "09:00", { payment: PAID });
    expect(booked.status).toBe(201);
    // The partnerWorld member is the linked ACCOUNT: reuse it for the prescription.
    const pw = await productWorld(w.aMember);
    const product = await pw.product();
    await pw.prescribe(product._id);
    const placed = await pw.place([{ itemRef: ref(product.sku), quantity: 2 }]);
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const org = alfredClient(app, alfredToken({ accountId: null }));
    const seen: { kind: string; ref: string }[] = [];
    let cursor: string | null = null;
    do {
      const page = await org.get(`/orders?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.data.items);
      cursor = page.body.data.nextCursor;
    } while (cursor);
    expect(seen.map((i) => i.kind).sort()).toEqual(["booking", "purchase"]);
    const only = await org.get("/orders?kind=purchase");
    expect(only.body.data.items).toHaveLength(1);
    expect(only.body.data.items[0]).toMatchObject({
      kind: "purchase",
      ref: placed.body.data.orderRef,
      accountId: ACCOUNT,
      status: "placed",
      itemRef: ref(product.sku),
      payment: { status: "pending", amountCents: 0, currency: "usd" },
      summary: { title: product.name },
      totals: { subtotalCents: 6800, taxCents: 0, totalCents: 6800 },
    });
    expect(JSON.stringify(only.body)).not.toContain("ADDRESS-SENTINEL");
    expect(
      (await org.get("/orders?kind=booking")).body.data.items.map((i: { kind: string }) => i.kind)
    ).toEqual(["booking"]);
    expect((await org.get("/orders?kind=enrollment")).body.data.items).toEqual([]);
    // updatedSince is inclusive and moves with the order.
    await ProductOrder.updateOne(
      { _id: placed.body.data.orderRef },
      { $set: { status: "cancelled" } }
    );
    const since = new Date(Date.now() + 1000).toISOString();
    expect(
      (await org.get(`/orders?kind=purchase&updatedSince=${since}`)).body.data.items
    ).toHaveLength(0);
  });
});
