import type { ProductOrderData } from "./productOrder.model.js";

type Row = ProductOrderData & { _id: unknown; updatedAt?: Date };

/** The order shape of contract §5.10, identical for create (201), read and the orders stream. */
export const orderView = (row: Row) => ({
  orderRef: String(row._id),
  status: row.status,
  items: row.items.map((i) => ({
    itemRef: i.itemRef,
    quantity: i.quantity,
    unitPriceCents: i.unitPriceCents,
    lineTotalCents: i.lineTotalCents,
    title: i.title,
  })),
  totals: {
    subtotalCents: row.totals.subtotalCents,
    shippingCents: row.totals.shippingCents,
    taxCents: row.totals.taxCents,
    totalCents: row.totals.totalCents,
    currency: row.totals.currency ?? "usd",
  },
});

/** `GET /orders/{ref}`: the create shape plus tracking and the dates reached. */
export const orderDetail = (row: Row) => ({
  ...orderView(row),
  ...(row.tracking?.carrier && row.tracking.number
    ? {
        tracking: {
          carrier: row.tracking.carrier,
          number: row.tracking.number,
          ...(row.tracking.url ? { url: row.tracking.url } : {}),
        },
      }
    : {}),
  ...(row.shippedAt ? { shippedAt: row.shippedAt } : {}),
  ...(row.deliveredAt ? { deliveredAt: row.deliveredAt } : {}),
  ...(row.cancelledAt ? { cancelledAt: row.cancelledAt } : {}),
});

const paymentStatus = (row: Row) =>
  row.refundedAt ? "refunded" : row.paidAt ? "paid" : row.status === "placed" ? "pending" : "none";

const titleOf = (row: Row) => {
  const first = row.items[0]?.title ?? "Order";
  return row.items.length > 1 ? `${first} + ${row.items.length - 1} more` : first;
};

/** One row of the `GET /orders` stream (`kind: purchase`). Never carries the address. */
export const purchaseItem = (row: Row) => ({
  kind: "purchase" as const,
  ref: String(row._id),
  accountId: row.accountId,
  status: row.status,
  itemRef: row.items[0]?.itemRef,
  payment: {
    status: paymentStatus(row),
    amountCents: row.paidCents ?? 0,
    currency: row.totals.currency ?? "usd",
  },
  summary: { title: titleOf(row) },
  totals: orderView(row).totals,
  updatedAt: row.updatedAt,
});
