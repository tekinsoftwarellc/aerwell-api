import type { Request } from "express";
import mongoose, { type ClientSession } from "mongoose";
import type { z } from "zod";
import { BadRequestError, ConflictError, NotFoundError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { logger } from "../../common/utils/logger.js";
import { env } from "../../config/env.js";
import { enqueueForMember } from "../alfred-partner/outbox/partnerOutbox.service.js";
import { contractConflict } from "../alfred-partner/partner.errors.js";
import type { orderBody } from "../alfred-partner/partner.schema.js";
import { audit } from "../audit/audit.js";
import { SupplementProduct } from "../supplement/supplement.js";
import { claimPrescription, consumePrescriptions, releasePrescriptions } from "./prescription.js";
import { skuOf } from "./productCatalog.js";
import { orderCancelled, orderDelivered, orderShipped } from "./productOrder.events.js";
import { ProductOrder } from "./productOrder.model.js";

export type OrderBody = z.output<typeof orderBody>;
/** Unpaid placed orders give their stock back after this long (Alfred places first and pays after). */
export const UNPAID_RELEASE_MS = 30 * 60_000;
const SHIPS_TO = "US";
const isShipped = (status: string) => status === "shipped" || status === "delivered";
const alreadyShipped = () =>
  contractConflict("ALREADY_SHIPPED", "This order has shipped and can no longer be cancelled");

/** The stock decrement of one line. `timestamps: false`: a sale must not move the catalog version. */
const reserve = (productId: unknown, quantity: number, session: ClientSession) =>
  SupplementProduct.updateOne(
    { _id: productId, stock: { $gte: quantity } },
    { $inc: { stock: -quantity } },
    { session, timestamps: false }
  );
const restore = (productId: unknown, quantity: number, session: ClientSession) =>
  SupplementProduct.updateOne(
    { _id: productId },
    { $inc: { stock: quantity } },
    { session, timestamps: false }
  );

/** Resolve `itemRef`s to sellable products: 404 unknown. The prescription is claimed at reservation. */
async function resolveLines(organizationId: string, items: OrderBody["items"]) {
  const wanted = new Map<string, number>();
  for (const item of items)
    wanted.set(item.itemRef, (wanted.get(item.itemRef) ?? 0) + item.quantity);
  const skus = [...wanted.keys()].map((ref) => skuOf(ref));
  const products = await SupplementProduct.find({
    organizationId,
    sku: { $in: skus.filter((s): s is string => s !== null) },
    active: true,
    forSale: true,
  }).lean();
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const lines = [...wanted].map(([itemRef, quantity]) => {
    const product = bySku.get(skuOf(itemRef) ?? "");
    if (!product) throw new NotFoundError("Unknown item");
    return { itemRef, quantity, product };
  });
  return lines;
}

/** `POST /orders`: price, reserve the last units atomically, and record the order as `placed`. */
export async function placeOrder(req: Request, body: OrderBody) {
  const member = req.partnerMember;
  if (!member) throw new NotFoundError("Member not found");
  if (body.accountId !== req.partner?.accountId)
    throw new BadRequestError("accountId must match the acting member");
  if (body.shippingAddress.country.toUpperCase() !== SHIPS_TO)
    throw contractConflict("SHIPPING_UNAVAILABLE", "We only ship within the United States");
  const lines = await resolveLines(member.organizationId, body.items);
  const priced = lines.map((l) => ({
    productId: l.product._id,
    itemRef: l.itemRef,
    title: l.product.name,
    quantity: l.quantity,
    unitPriceCents: l.product.priceCents,
    lineTotalCents: l.product.priceCents * l.quantity,
  }));
  const subtotalCents = priced.reduce((sum, l) => sum + l.lineTotalCents, 0);
  const shippingCents = env.PRODUCT_SHIPPING_FLAT_CENTS;
  // The whole reservation is one transaction: a short line rolls back the lines before it. Two orders
  // for the last unit conflict on the product row; the loser retries, finds no stock and is refused.
  const orderId = new mongoose.Types.ObjectId();
  const prepaid = body.payment.status === "paid";
  return mongoose.connection.transaction(async (session) => {
    for (const line of priced) {
      await claimPrescription(
        { organizationId: member.organizationId, memberId: member._id, ...line, orderId },
        session
      );
      const done = await reserve(line.productId, line.quantity, session);
      if (done.modifiedCount !== 1)
        throw contractConflict("OUT_OF_STOCK", "An item is not available in that quantity");
    }
    const [row] = await ProductOrder.create(
      [
        {
          _id: orderId,
          organizationId: member.organizationId,
          memberId: member._id,
          accountId: body.accountId,
          items: priced,
          shippingAddress: body.shippingAddress,
          // Prices are tax-inclusive (Q11): tax is always 0 and the total is what the member sees.
          totals: {
            subtotalCents,
            shippingCents,
            taxCents: 0,
            totalCents: subtotalCents + shippingCents,
            currency: "usd",
          },
          acceptedTermsVersion: body.acceptedTermsVersion,
          alfredOrderRef: body.alfredOrderRef,
          // An order Alfred already charged (§5.7 style `paid`) is recorded as paid, so the sweep never releases it.
          ...(prepaid
            ? {
                status: "paid",
                paidAt: new Date(),
                paidCents: body.payment.amountCents,
                paymentIntentId: body.payment.paymentIntentId,
              }
            : {}),
        },
      ],
      { session }
    );
    if (!row) throw new Error("Order not created");
    if (prepaid) await consumePrescriptions(orderId, session);
    await audit(req, "placed", "ProductOrder", String(row._id), String(member._id), session);
    return row;
  });
}

/** The acting member's own order. Another member's, or a malformed ref, is a plain 404. */
export async function ownedOrder(req: Request, orderRef: string) {
  const member = req.partnerMember;
  const row =
    member && objectId.safeParse(orderRef).success
      ? await ProductOrder.findOne({
          _id: orderRef,
          organizationId: member.organizationId,
          memberId: member._id,
        })
      : null;
  if (!row) throw new NotFoundError("Order not found");
  return row;
}

type Cancel = { by: "member" | "staff" | "system"; req?: Request; unpaidBefore?: Date };

/**
 * Cancel a placed or paid order, give its stock back and (for staff and system) tell Alfred, all in
 * one transaction. A repeat answers the same; a shipped order is 409 ALREADY_SHIPPED. `unpaidBefore`
 * makes it the auto-release: only an unpaid order older than that is touched.
 */
export async function cancelOrder(
  filter: { _id: unknown; organizationId: string; memberId?: unknown },
  how: Cancel
) {
  return mongoose.connection.transaction(async (session) => {
    const row = await ProductOrder.findOne(filter).session(session);
    if (!row) throw new NotFoundError("Order not found");
    if (row.status === "cancelled" || row.status === "refunded") return { row, changed: false };
    if (isShipped(row.status)) throw alreadyShipped();
    if (how.unpaidBefore && (row.status !== "placed" || row.createdAt >= how.unpaidBefore))
      return { row, changed: false };
    const at = new Date();
    const giveBack = !row.stockReleased;
    row.set({
      status: "cancelled",
      cancelledAt: at,
      cancelledBy: how.by,
      // Alfred refunds what it charged: all of a paid order, nothing for an unpaid one.
      cancelRefundCents: row.status === "paid" ? row.totals.totalCents : 0,
      stockReleased: true,
    });
    await row.save({ session });
    if (giveBack) {
      for (const item of row.items) await restore(item.productId, item.quantity, session);
      await releasePrescriptions(row._id, session);
    }
    if (how.by !== "member")
      await enqueueForMember(
        row.memberId,
        async (accountId) => orderCancelled(accountId, row, how.by, at, row.cancelRefundCents),
        session
      );
    if (how.req)
      await audit(
        how.req,
        "cancelled",
        "ProductOrder",
        String(row._id),
        String(row.memberId),
        session
      );
    return { row, changed: true };
  });
}

/** `POST /orders/{ref}/cancel` from Alfred on the member's behalf. */
export async function cancelForMember(req: Request, orderRef: string) {
  const owned = await ownedOrder(req, orderRef);
  const { row } = await cancelOrder(
    { _id: owned._id, organizationId: owned.organizationId, memberId: owned.memberId },
    { by: "member", req }
  );
  return { status: "cancelled" as const, refundCents: row.cancelRefundCents };
}

/** The auto-release sweep: unpaid placed orders older than 30 minutes. Never throws. */
export async function releaseUnpaidOrders(now = new Date()): Promise<number> {
  const unpaidBefore = new Date(now.getTime() - UNPAID_RELEASE_MS);
  const stale = await ProductOrder.find({ status: "placed", createdAt: { $lt: unpaidBefore } })
    .select("_id organizationId")
    .limit(100)
    .lean();
  let released = 0;
  for (const order of stale) {
    try {
      const done = await cancelOrder(
        { _id: order._id, organizationId: order.organizationId },
        { by: "system", unpaidBefore }
      );
      if (done.changed) released += 1;
    } catch (error) {
      logger.error({ errorType: (error as Error).name }, "unpaid product order release failed");
    }
  }
  return released;
}

/** In-process sweep every minute (the transition is conditional, so a second process is safe). */
export function startProductOrderRelease(): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await releaseUnpaidOrders();
    } finally {
      running = false;
    }
  }, 60_000);
  timer.unref();
  return timer;
}

// ── staff fulfilment ──────────────────────────────────────────────────────────

const staffOrder = async (req: Request, id: string) => {
  const organizationId = req.staff?.organizationId;
  const row = organizationId ? await ProductOrder.findOne({ _id: id, organizationId }) : null;
  if (!row) throw new NotFoundError("Order not found");
  return row;
};

/** Mark a paid order shipped with its tracking (optional) and tell Alfred. A repeat is a 409. */
export async function markShipped(
  req: Request,
  id: string,
  tracking: { carrier: string; number: string; url?: string | undefined } | undefined
) {
  const found = await staffOrder(req, id);
  return mongoose.connection.transaction(async (session) => {
    const row = await ProductOrder.findById(found._id).session(session);
    if (!row) throw new NotFoundError("Order not found");
    if (row.status !== "paid")
      throw new ConflictError(
        isShipped(row.status) ? "Already shipped" : "Only a paid order can be shipped",
        undefined,
        isShipped(row.status) ? "ALREADY_SHIPPED" : "ORDER_NOT_PAID"
      );
    const at = new Date();
    row.set({ status: "shipped", shippedAt: at, ...(tracking ? { tracking } : {}) });
    await row.save({ session });
    await enqueueForMember(row.memberId, async (a) => orderShipped(a, row, at), session);
    await audit(req, "shipped", "ProductOrder", String(row._id), String(row.memberId), session);
    return row;
  });
}

export async function markDelivered(req: Request, id: string) {
  const found = await staffOrder(req, id);
  return mongoose.connection.transaction(async (session) => {
    const row = await ProductOrder.findById(found._id).session(session);
    if (!row) throw new NotFoundError("Order not found");
    if (row.status === "delivered") return row;
    if (row.status !== "shipped")
      throw new ConflictError("Only a shipped order can be delivered", undefined, "NOT_SHIPPED");
    const at = new Date();
    row.set({ status: "delivered", deliveredAt: at });
    await row.save({ session });
    await enqueueForMember(row.memberId, async (a) => orderDelivered(a, row, at), session);
    await audit(req, "delivered", "ProductOrder", String(row._id), String(row.memberId), session);
    return row;
  });
}

export async function staffCancel(req: Request, id: string) {
  const found = await staffOrder(req, id);
  return (
    await cancelOrder(
      { _id: found._id, organizationId: found.organizationId },
      { by: "staff", req }
    )
  ).row;
}

// ── inbound payment events ────────────────────────────────────────────────────

type PaymentEvent = {
  idempotencyKey: string;
  accountId?: string | undefined;
  occurredAt: string;
  resource: { ref: string };
  payload: Record<string, unknown>;
};
const dateOf = (value: unknown, fallback: string) =>
  new Date(typeof value === "string" ? value : fallback);

const eventOrder = async (organizationId: string, event: PaymentEvent, session: ClientSession) => {
  const accountId = event.accountId ?? String(event.payload["accountId"] ?? "");
  if (!(objectId.safeParse(event.resource.ref).success && accountId)) return null;
  return ProductOrder.findOne({ _id: event.resource.ref, organizationId, accountId }).session(
    session
  );
};

/**
 * `order.paid`. Idempotent by state: the first payment fixes `paidAt`. An order the 30-minute release
 * already cancelled is told to Alfred again with the refund it now owes, so a late charge is never kept.
 */
export async function recordProductPaid(organizationId: string, event: PaymentEvent) {
  await mongoose.connection.transaction(async (session) => {
    const row = await eventOrder(organizationId, event, session);
    if (!row || row.paidAt) return;
    const amount = event.payload["amountCents"];
    const paidCents = typeof amount === "number" ? amount : row.totals.totalCents;
    row.set({
      paidAt: dateOf(event.payload["paidAt"], event.occurredAt),
      paidCents,
      ...(typeof event.payload["paymentIntentId"] === "string"
        ? { paymentIntentId: event.payload["paymentIntentId"] }
        : {}),
      ...(row.status === "placed" ? { status: "paid" } : {}),
      ...(row.status === "cancelled" ? { cancelRefundCents: paidCents } : {}),
    });
    await row.save({ session });
    if (row.status === "paid") await consumePrescriptions(row._id, session);
    if (row.status === "cancelled")
      await enqueueForMember(
        row.memberId,
        async (accountId) =>
          orderCancelled(
            accountId,
            row,
            row.cancelledBy ?? "system",
            // After the first cancel event: the outbox key is (type, ref, time), so it must differ.
            new Date(Math.max(Date.now(), (row.cancelledAt?.getTime() ?? 0) + 1)),
            paidCents
          ),
        session
      );
  });
}

/**
 * `order.refunded`: Alfred sends one event per refund with that refund's amount, so amounts add up;
 * the event's idempotency key is kept on the order so a replayed handler adds nothing. Only a refund of
 * everything paid moves a paid, shipped or delivered order to `refunded`, and a paid order that has not
 * shipped gives its stock back then. A cancelled order stays cancelled; a partial refund changes no status.
 */
export async function recordProductRefund(organizationId: string, event: PaymentEvent) {
  await mongoose.connection.transaction(async (session) => {
    const row = await eventOrder(organizationId, event, session);
    if (!row || row.refundEventKeys.includes(event.idempotencyKey)) return;
    const amount = event.payload["amountCents"];
    const refundedCents = (row.refundedCents ?? 0) + (typeof amount === "number" ? amount : 0);
    const whole = row.paidCents > 0 && refundedCents >= row.paidCents;
    const live = ["paid", "shipped", "delivered"].includes(row.status);
    const unshipped = row.status === "paid" && !row.stockReleased;
    row.set({
      refundedAt: row.refundedAt ?? dateOf(event.payload["refundedAt"], event.occurredAt),
      refundedCents,
      refundEventKeys: [...row.refundEventKeys, event.idempotencyKey],
      ...(live && whole ? { status: "refunded" } : {}),
      ...(unshipped && whole ? { stockReleased: true } : {}),
    });
    await row.save({ session });
    if (unshipped && whole) {
      for (const item of row.items) await restore(item.productId, item.quantity, session);
      await releasePrescriptions(row._id, session);
    }
  });
}
