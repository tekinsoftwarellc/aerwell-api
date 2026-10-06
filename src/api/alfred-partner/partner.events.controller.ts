import type { Request, Response } from "express";
import type { z } from "zod";
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { env } from "../../config/env.js";
import { Appointment } from "../appointment/appointment.model.js";
import { Member } from "../member/member.model.js";
import type { eventBody } from "./partner.schema.js";
import { STALE_CLAIM_MS } from "./partnerIdempotency.js";
import { PartnerIdempotencyKey } from "./partnerIdempotency.model.js";

type Event = z.output<typeof eventBody>;
const isDuplicate = (error: unknown) => (error as { code?: number }).code === 11000;
const dateOf = (value: unknown, fallback: string) =>
  new Date(typeof value === "string" ? value : fallback);

/** `member.deleted`: unlink only. The clinical record and everything in it stays. */
async function unlink(organizationId: string, event: Event) {
  const accountId = event.accountId ?? String(event.payload["accountId"] ?? "");
  if (accountId)
    await Member.updateOne(
      { organizationId, alfredAccountId: accountId },
      { $set: { alfredUnlinkedAt: new Date() } }
    );
}

/** The booking the event names, only when it belongs to the account the event is about. */
async function bookingOf(organizationId: string, event: Event) {
  if (!objectId.safeParse(event.resource.ref).success) return null;
  const row = await Appointment.findOne({ _id: event.resource.ref, organizationId });
  if (!row) return null;
  const accountId = event.accountId ?? String(event.payload["accountId"] ?? "");
  const owner = await Member.exists({ _id: row.memberId, alfredAccountId: accountId });
  return owner ? row : null;
}

/** `order.paid`: Alfred charged a booking that was accepted unpaid. Never moves a refunded payment back. */
async function recordPaid(organizationId: string, event: Event) {
  const row = await bookingOf(organizationId, event);
  if (!row || (row.externalPayment as { refundedAt?: Date } | undefined)?.refundedAt) return;
  const paid = event.payload["amountCents"];
  await Appointment.updateOne(
    { _id: row._id },
    {
      $set: {
        paymentStatus: "paid_external",
        "externalPayment.status": "paid",
        "externalPayment.paymentIntentId": event.payload["paymentIntentId"],
        "externalPayment.paidAt": dateOf(event.payload["paidAt"], event.occurredAt),
        ...(typeof paid === "number" ? { "externalPayment.amountCents": paid } : {}),
      },
    }
  );
}

async function recordRefund(organizationId: string, event: Event) {
  const row = await bookingOf(organizationId, event);
  if (!row) return;
  const refunded = event.payload["amountCents"];
  await Appointment.updateOne(
    { _id: row._id },
    {
      $set: {
        "externalPayment.refundedAt": dateOf(event.payload["refundedAt"], event.occurredAt),
        ...(typeof refunded === "number" ? { "externalPayment.refundedCents": refunded } : {}),
      },
    }
  );
}

const HANDLERS: Partial<Record<Event["type"], (org: string, event: Event) => Promise<void>>> = {
  // Alfred already applied the same change from the synchronous call: nothing to do.
  "member.deleted": unlink,
  "order.paid": recordPaid,
  "order.refunded": recordRefund,
};

/**
 * `POST /events` (§5.13): Alfred to partner. Receipt is 202; the same `idempotencyKey` answers
 * "duplicate" and processes nothing twice. An event naming something unknown is still 202.
 * A failure releases the key so Alfred's retry runs again.
 */
export async function receiveEvent(req: Request, res: Response): Promise<void> {
  const event = req.body as Event;
  const organizationId = env.AERWELL_ORG_ID;
  if (!organizationId) throw new AppError("Partner organization is not configured", 503);
  const claim = { organizationId, path: "/events:inbound", key: event.idempotencyKey };
  const reply = (status: "received" | "duplicate") =>
    res.status(202).json(ServiceResponse.success("Event received", { status }, 202));
  try {
    await PartnerIdempotencyKey.create({ ...claim, method: "POST", bodyHash: event.type });
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    const seen = await PartnerIdempotencyKey.findOne(claim).lean();
    if (seen?.state === "done") {
      reply("duplicate");
      return;
    }
    // Still `pending`: a process died mid-handler (handlers are idempotent sets), or one is running now.
    const takeover = await PartnerIdempotencyKey.findOneAndUpdate(
      { ...claim, state: "pending", claimedAt: { $lt: new Date(Date.now() - STALE_CLAIM_MS) } },
      { $set: { claimedAt: new Date() } }
    );
    if (!takeover) {
      res.setHeader("Retry-After", "1");
      throw new AppError("This event is already being processed", 503);
    }
  }
  try {
    await HANDLERS[event.type]?.(organizationId, event);
    await PartnerIdempotencyKey.updateOne(claim, { $set: { state: "done", statusCode: 202 } });
  } catch (error) {
    await PartnerIdempotencyKey.deleteOne(claim);
    throw error;
  }
  reply("received");
}
