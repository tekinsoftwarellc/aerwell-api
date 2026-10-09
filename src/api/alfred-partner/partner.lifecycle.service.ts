import type { Request } from "express";
import type { ClientSession } from "mongoose";
import {
  Appointment,
  type AppointmentDocument,
  AssessmentEpisode,
  LIVE_STATUSES,
} from "../appointment/appointment.model.js";
import { assertSlot, lockedTransaction, roomLocks } from "../appointment/booking.service.js";
import { memberLock, providerLock } from "../appointment/ledger.service.js";
import { audit } from "../audit/audit.js";
import { Location } from "../location/location.model.js";
import { ALFRED_APP_ACTOR, appointmentChanged } from "../notification/producers.js";
import { Service } from "../service/service.model.js";
import { assertReviewOrder } from "./partner.bookings.service.js";
import { externalOf } from "./partner.bookings.view.js";
import { contractConflict, remapBookingError } from "./partner.errors.js";
import { decodeSlotRef } from "./slotRef.js";

const PARTNER_ACTOR = ALFRED_APP_ACTOR;
const HOUR = 3_600_000;
const CHECK_IN_LEAD_MS = 60 * 60_000;
const DEFAULT_WINDOW_HOURS = 24;
const SERVICE_FIELDS = "slug lateCancellationFee";

type Policy = {
  windowHours?: number | null;
  enabled?: boolean | null;
  amountCents?: number | null;
};
const windowHoursOf = (policy?: Policy | null) => policy?.windowHours ?? DEFAULT_WINDOW_HOURS;
/**
 * Alfred may only change what Alfred priced and charged. A staff-made booking can reach the member's
 * app, but it holds a unit in Aerwell's own ledger until cutover, and the Alfred path never touches
 * that ledger: cancelling or moving one is the clinic's job.
 */
const isAlfredPriced = (row: AppointmentDocument) => Boolean(row.externalPayment);
const isCancellable = (row: AppointmentDocument, now: Date) =>
  isAlfredPriced(row) && ["booked", "confirmed"].includes(row.status) && row.startAt > now;

/**
 * The cancellation rule. It is Aerwell's, not Alfred's (§5.7): the window is the service's
 * `lateCancellationFee.windowHours` (24 h unless an admin changes it). Inside it the cancel is
 * LATE: the unit is used up whatever the fee, and the fee is the admin-set amount (0 when none).
 */
export function cancelTerms(
  row: AppointmentDocument,
  policy: Policy | null | undefined,
  now: Date
) {
  const hours = windowHoursOf(policy);
  const late = row.startAt.getTime() - now.getTime() < hours * HOUR;
  const feeCents = late && policy?.enabled ? (policy.amountCents ?? 0) : 0;
  const paid = externalOf(row).amountCents ?? 0;
  return {
    allowed: isCancellable(row, now),
    late,
    feeCents,
    refundCents: Math.max(0, paid - feeCents),
    currency: externalOf(row).currency ?? "usd",
    windowEndsAt: late ? null : new Date(row.startAt.getTime() - hours * HOUR),
    hours,
  };
}

const policyOf = async (row: AppointmentDocument) =>
  (await Service.findById(row.serviceId).select(SERVICE_FIELDS).lean())?.lateCancellationFee;

/** `GET /bookings/{ref}/cancellation-quote`: the only place Alfred learns the window. */
export async function cancellationQuote(row: AppointmentDocument, now = new Date()) {
  const terms = cancelTerms(row, await policyOf(row), now);
  if (!terms.allowed)
    return {
      allowed: false,
      feeCents: 0,
      refundCents: 0,
      currency: terms.currency,
      windowEndsAt: null,
      policyText: isAlfredPriced(row)
        ? "This booking can no longer be cancelled."
        : "Please contact the clinic to change this booking.",
    };
  return {
    allowed: true,
    feeCents: terms.feeCents,
    refundCents: terms.refundCents,
    currency: terms.currency,
    windowEndsAt: terms.windowEndsAt,
    policyText: terms.late
      ? `Cancelling now uses your visit${terms.feeCents ? ` and a fee of ${terms.feeCents} cents applies` : ""}.`
      : `Free until ${terms.hours} hours before the visit. Later cancellations use your visit.`,
  };
}

/** What a cancelled booking answered (or would answer on a repeat). A repeat keeps the stored fee. */
function cancelledAnswer(row: AppointmentDocument) {
  const stored = row.cancellation;
  const fee = stored?.feeCents ?? 0;
  const paid = externalOf(row).amountCents ?? 0;
  return {
    status: "cancelled",
    feeCents: fee,
    refundCents: stored?.refundCents ?? Math.max(0, paid - fee),
    currency: externalOf(row).currency ?? "usd",
    late: stored?.late ?? false,
  };
}

/** When nothing live is left in an assessment episode, the episode is cancelled with it. */
async function closeEmptyEpisode(row: AppointmentDocument, session: ClientSession) {
  if (!row.episodeId) return;
  const live = await Appointment.exists({
    episodeId: row.episodeId,
    status: { $in: LIVE_STATUSES },
  }).session(session);
  if (!live)
    await AssessmentEpisode.updateOne(
      { _id: row.episodeId, status: "open" },
      { $set: { status: "cancelled", cancelledAt: new Date() } },
      { session }
    );
}

/** `POST /bookings/{ref}/cancel`. A repeat answers the stored result; after the start it is 409. */
export async function cancelAlfredBooking(req: Request, row: AppointmentDocument, reason?: string) {
  if (row.status === "cancelled") return cancelledAnswer(row);
  const policy = await policyOf(row);
  const done = await lockedTransaction(
    [memberLock(row.memberId), providerLock(row.providerId)],
    async (session) => {
      const now = new Date();
      const fresh = await Appointment.findById(row._id).session(session);
      if (fresh?.status === "cancelled") return { row: fresh, changed: false };
      if (!(fresh && isCancellable(fresh, now)))
        throw contractConflict(
          "OUTSIDE_CANCELLATION_WINDOW",
          "This booking can no longer be cancelled"
        );
      const terms = cancelTerms(fresh, policy, now);
      // Conditional on the status just validated: a staff change racing us makes this miss.
      const updated = await Appointment.findOneAndUpdate(
        { _id: fresh._id, status: { $in: ["booked", "confirmed"] } },
        {
          $set: {
            status: "cancelled",
            cancellation: {
              at: now,
              by: "member",
              reason,
              late: terms.late,
              feeCents: terms.feeCents,
              refundCents: terms.refundCents,
              // The unit lives in Alfred: nothing is settled in Aerwell's ledger.
              allowance: "none",
            },
          },
          $push: { statusHistory: { status: "cancelled", at: now } },
        },
        { session, new: true }
      );
      if (!updated)
        throw contractConflict(
          "OUTSIDE_CANCELLATION_WINDOW",
          "This booking can no longer be cancelled"
        );
      await closeEmptyEpisode(updated, session);
      await audit(
        req,
        "cancelled",
        "Appointment",
        String(updated._id),
        String(updated.memberId),
        session
      );
      return { row: updated, changed: true };
    }
  ).catch((error) => {
    throw remapBookingError(error);
  });
  if (done.changed) await appointmentChanged("appointment_cancelled", done.row, PARTNER_ACTOR);
  return cancelledAnswer(done.row);
}

/** `POST /bookings/{ref}/check-in`: from 60 minutes before the start to the end. A repeat answers the same. */
export async function checkInAlfredBooking(req: Request, row: AppointmentDocument) {
  const now = new Date();
  const checkedInAt = (r: AppointmentDocument) =>
    [...r.statusHistory].reverse().find((h) => h.status === "checked_in")?.at ?? now;
  if (row.status === "checked_in" || row.status === "in_progress")
    return { status: "checked_in", checkedInAt: checkedInAt(row) };
  const open = ["booked", "confirmed"].includes(row.status);
  if (!open || now.getTime() < row.startAt.getTime() - CHECK_IN_LEAD_MS || now > row.endAt)
    throw contractConflict("CHECK_IN_WINDOW", "Check-in is not open for this booking");
  const updated = await Appointment.findOneAndUpdate(
    { _id: row._id, status: { $in: ["booked", "confirmed"] } },
    { $set: { status: "checked_in" }, $push: { statusHistory: { status: "checked_in", at: now } } },
    { new: true }
  );
  if (!updated) throw contractConflict("CHECK_IN_WINDOW", "Check-in is not open for this booking");
  await audit(
    req,
    "status_checked_in",
    "Appointment",
    String(updated._id),
    String(updated.memberId)
  );
  return { status: "checked_in", checkedInAt: now };
}

/**
 * `POST /bookings/{ref}/reschedule`. Same item and place; the provider may change. Alfred re-prices
 * (Aerwell does not): the payment record is kept as is. Inside the 24 hour window, 409.
 */
export async function rescheduleAlfredBooking(
  req: Request,
  row: AppointmentDocument,
  slotRef: string
) {
  const slot = decodeSlotRef(slotRef);
  // The whole row: the slot check reads assignments, environment and capacity from it.
  const service = await Service.findById(row.serviceId);
  const location = await Location.findById(row.locationId);
  if (!(slot && service && location))
    throw contractConflict("SLOT_TAKEN", "That time is no longer available");
  if (slot.slug !== service.slug || slot.locationId !== String(row.locationId))
    throw contractConflict("SLOT_TAKEN", "That time is no longer available");
  // Retried after a crash, or moved to where it already is: the answer is the move, not a refusal.
  const sameSlot =
    row.startAt.getTime() === slot.startAt.getTime() && String(row.providerId) === slot.providerId;
  if (sameSlot && ["booked", "confirmed"].includes(row.status)) return row;
  const hours = windowHoursOf(service.lateCancellationFee);
  if (
    !(isAlfredPriced(row) && ["booked", "confirmed"].includes(row.status)) ||
    row.startAt.getTime() - Date.now() < hours * HOUR
  )
    throw contractConflict("OUTSIDE_RESCHEDULE_WINDOW", "This booking can no longer be moved");
  const previousProvider = String(row.providerId);
  const keys = [
    memberLock(row.memberId),
    providerLock(previousProvider),
    providerLock(slot.providerId),
    ...(await roomLocks(row.serviceId)),
  ];
  try {
    const moved = await lockedTransaction([...new Set(keys)], async (session) => {
      const fresh = await Appointment.findById(row._id).session(session);
      if (!fresh || !["booked", "confirmed"].includes(fresh.status))
        throw contractConflict("OUTSIDE_RESCHEDULE_WINDOW", "This booking can no longer be moved");
      const endAt = await assertSlot(
        { service, location },
        {
          organizationId: fresh.organizationId,
          memberId: fresh.memberId,
          providerId: slot.providerId,
          startAt: slot.startAt,
          excludeId: fresh._id,
          deliveryMethod: fresh.deliveryMethod ?? undefined,
        },
        session
      );
      if (fresh.episodeId)
        await assertReviewOrder(fresh.episodeId, service, slot.startAt, endAt, session, fresh._id);
      fresh.set({
        startAt: slot.startAt,
        endAt,
        providerId: slot.providerId,
        rescheduledAt: new Date(),
      });
      await fresh.save({ session });
      await audit(
        req,
        "rescheduled",
        "Appointment",
        String(fresh._id),
        String(fresh.memberId),
        session
      );
      return fresh;
    });
    await appointmentChanged("appointment_rescheduled", moved, PARTNER_ACTOR, [
      ...new Set([previousProvider, String(moved.providerId)]),
    ]);
    return moved;
  } catch (error) {
    throw remapBookingError(error);
  }
}
