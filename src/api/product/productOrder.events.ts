import type { OutboxEvent } from "../alfred-partner/outbox/partnerOutbox.service.js";
import type { ProductOrderData } from "./productOrder.model.js";

type Row = ProductOrderData & { _id: unknown };
const ORDER = (row: Row) => ({ kind: "order", ref: String(row._id) });

/**
 * Order events (contract §7): refs, statuses, dates, tracking and amounts only. Never the address,
 * the product names or a cancel reason: the member's notification is composed from `title` and `body`.
 */
export function orderShipped(accountId: string, row: Row, at: Date): OutboxEvent {
  return {
    type: "order.shipped",
    occurredAt: at,
    accountId,
    resource: ORDER(row),
    payload: {
      orderRef: String(row._id),
      status: "shipped",
      shippedAt: at,
      ...(row.tracking?.carrier && row.tracking.number
        ? {
            tracking: {
              carrier: row.tracking.carrier,
              number: row.tracking.number,
              ...(row.tracking.url ? { url: row.tracking.url } : {}),
            },
          }
        : {}),
    },
  };
}

export const orderDelivered = (accountId: string, row: Row, at: Date): OutboxEvent => ({
  type: "order.delivered",
  occurredAt: at,
  accountId,
  resource: ORDER(row),
  payload: { orderRef: String(row._id), status: "delivered", deliveredAt: at },
});

export const orderCancelled = (
  accountId: string,
  row: Row,
  by: "member" | "staff" | "system",
  at: Date,
  refundCents: number
): OutboxEvent => ({
  type: "order.cancelled",
  occurredAt: at,
  accountId,
  resource: ORDER(row),
  payload: {
    orderRef: String(row._id),
    status: "cancelled",
    cancelledBy: by,
    refundCents,
    title: "Order cancelled",
    body: refundCents > 0 ? "Your order was cancelled and refunded." : "Your order was cancelled.",
  },
});
