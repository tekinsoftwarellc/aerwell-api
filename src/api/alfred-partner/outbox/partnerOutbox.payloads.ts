import type { AppointmentData } from "../../appointment/appointment.model.js";
import { tagsFor } from "../catalogItem.js";
import { bookingView, loadRefs } from "../partner.bookings.view.js";
import type { OutboxEvent } from "./partnerOutbox.service.js";

type Row = AppointmentData & { _id: unknown; updatedAt?: Date };
const BOOKING = (row: Row) => ({ kind: "booking", ref: String(row._id) });

/**
 * Booking events (contract §7). Only identifiers, times, display titles and amounts: never the
 * member's notes, visit reason, address or any clinical content.
 */
export async function bookingCreated(accountId: string, row: Row): Promise<OutboxEvent> {
  const refs = await loadRefs([row]);
  const view = bookingView(row, refs);
  return {
    type: "booking.created",
    occurredAt: new Date(),
    accountId,
    resource: BOOKING(row),
    payload: {
      bookingRef: view.bookingRef,
      itemRef: refs.service.get(String(row.serviceId))?.slug,
      status: view.status,
      startAt: view.startAt,
      endAt: view.endAt,
      locationRef: view.locationRef,
      staff: view.staff,
      payment: view.payment,
      summary: view.summary,
      tags: tagsFor(row.modality, Boolean(row.episodeId)),
    },
  };
}

export async function bookingRescheduled(
  accountId: string,
  row: Row,
  previousStartAt: Date
): Promise<OutboxEvent> {
  const view = bookingView(row, await loadRefs([row]), "rescheduled");
  return {
    type: "booking.rescheduled",
    occurredAt: new Date(),
    accountId,
    resource: BOOKING(row),
    payload: {
      bookingRef: view.bookingRef,
      status: "rescheduled",
      startAt: view.startAt,
      endAt: view.endAt,
      previousStartAt,
      locationRef: view.locationRef,
      staff: view.staff,
    },
  };
}

export interface Cancellation {
  by: "member" | "staff" | "system";
  at: Date;
  feeCents: number;
  late: boolean;
}
/** `refundCents` is what Alfred refunds on its own order: what was paid, less the fee, never below 0. */
export function bookingCancelled(accountId: string, row: Row, c: Cancellation): OutboxEvent {
  const paid = (row.externalPayment as { amountCents?: number } | undefined)?.amountCents ?? 0;
  return {
    type: "booking.cancelled",
    occurredAt: c.at,
    accountId,
    resource: BOOKING(row),
    payload: {
      bookingRef: String(row._id),
      status: "cancelled",
      cancelledBy: c.by,
      cancelledAt: c.at,
      feeCents: c.feeCents,
      refundCents: Math.max(0, paid - c.feeCents),
      late: c.late,
    },
  };
}

export function bookingStatus(
  accountId: string,
  row: Row,
  status: "checked_in" | "completed" | "no_show"
): OutboxEvent {
  const at = new Date();
  return {
    type: status === "checked_in" ? "booking.checked_in" : "booking.completed",
    occurredAt: at,
    accountId,
    resource: BOOKING(row),
    payload:
      status === "checked_in"
        ? { bookingRef: String(row._id), status, checkedInAt: at }
        : { bookingRef: String(row._id), status, completedAt: at },
  };
}
