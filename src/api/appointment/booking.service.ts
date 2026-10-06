// Book and reschedule: every write re-evaluates the entitlement, re-validates
// the slot and reserves allowance inside ONE transaction that holds the member
// and provider booking locks.
import type { Request } from "express";
import mongoose, { type ClientSession, type Types } from "mongoose";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import {
  bookingCreated,
  bookingRescheduled,
} from "../alfred-partner/outbox/partnerOutbox.payloads.js";
import { enqueueForMember } from "../alfred-partner/outbox/partnerOutbox.service.js";
import { audit } from "../audit/audit.js";
import type { EntitlementQuote } from "../entitlement/entitlement.types.js";
import { STANDARD_DELIVERY } from "../entitlement/entitlement.types.js";
import { appointmentChanged } from "../notification/producers.js";
import { Service } from "../service/service.model.js";
import { Appointment, type AppointmentDocument, LIVE_STATUSES } from "./appointment.model.js";
import { eligibleProviders, slotCapacity, slotContext } from "./availability.service.js";
import {
  ensureLocks,
  environmentLock,
  ledger,
  memberLock,
  providerLock,
  takeLocks,
} from "./ledger.service.js";
import {
  type ExpectedQuote,
  assertBookable,
  assertExpected,
  buildQuote,
  priceOf,
  scopedMember,
} from "./quote.service.js";

const STEP_MS = 15 * 60_000;
export const paymentFields = (finalCents: number | null) => ({
  amountDueCents: finalCents ?? 0,
  paymentStatus: (finalCents ?? 0) > 0 ? "unconfigured" : "not_required",
});

export async function lockedTransaction<T>(
  keys: string[],
  work: (session: ClientSession) => Promise<T>
) {
  await ensureLocks(keys);
  return mongoose.connection.transaction(async (session) => {
    await takeLocks(keys, session);
    return work(session);
  });
}

export interface SlotRequest {
  organizationId: string;
  memberId: Types.ObjectId | string;
  providerId: string;
  startAt: Date;
  excludeId?: unknown;
  /** Anything but the standard delivery (mobile phlebotomy) needs no room or machine. */
  deliveryMethod?: string;
}
type Quoted = Pick<Awaited<ReturnType<typeof buildQuote>>, "service" | "location">;

/** The lock a room or machine needs so two members with two providers cannot both take it. */
export async function roomLocks(serviceId: Types.ObjectId | string): Promise<string[]> {
  const service = await Service.findOne({ _id: serviceId }).select("environmentId").lean();
  return service?.environmentId ? [environmentLock(service.environmentId)] : [];
}

/** Provider eligibility, grid alignment, shift/PTO/hours/room/capacity and member overlap. */
export async function assertSlot(quoted: Quoted, slot: SlotRequest, session: ClientSession) {
  const { service, location } = quoted;
  if (!(await eligibleProviders(service, slot.providerId, session)).length)
    throw new ValidationError(
      "This provider does not deliver this service",
      "PROVIDER_NOT_ELIGIBLE"
    );
  if (slot.startAt.getTime() % STEP_MS !== 0)
    throw new ValidationError("Start on a 15-minute boundary", "SLOT_NOT_ALIGNED");
  const endAt = new Date(slot.startAt.getTime() + service.durationMinutes * 60_000);
  const ctx = await slotContext(
    location,
    service,
    slot.providerId,
    {
      start: slot.startAt,
      end: endAt,
    },
    {
      session,
      excludeAppointmentId: slot.excludeId,
      ...(slot.deliveryMethod ? { deliveryMethod: slot.deliveryMethod } : {}),
    }
  );
  if (slotCapacity(ctx, slot.startAt) === 0)
    throw new ConflictError("That time is no longer available", undefined, "SLOT_UNAVAILABLE");
  const clash = await Appointment.exists({
    organizationId: slot.organizationId,
    memberId: slot.memberId,
    status: { $in: LIVE_STATUSES },
    startAt: { $lt: endAt },
    endAt: { $gt: slot.startAt },
    ...(slot.excludeId ? { _id: { $ne: slot.excludeId } } : {}),
  }).session(session);
  if (clash)
    throw new ConflictError(
      "The member already has an appointment at that time",
      undefined,
      "MEMBER_DOUBLE_BOOKED"
    );
  return endAt;
}

/** Inside an episode only an unclaimed component may be booked, and it is always $0 + fees. */
function assertEpisodeComponent(quote: EntitlementQuote, episodeId?: string | null) {
  if (episodeId && quote.decision !== "episode_component")
    throw new ConflictError(
      "This component is already booked or no longer covered by the assessment",
      { quote: priceOf(quote) },
      "EPISODE_COMPONENT_UNAVAILABLE"
    );
}

async function reserveIfAllowance(
  req: Request,
  quote: EntitlementQuote,
  appointment: AppointmentDocument,
  session: ClientSession
) {
  if (quote.decision !== "allowance" || !quote.allowance || !quote.selection) return;
  await ledger.reserve(
    {
      organizationId: appointment.organizationId,
      memberId: appointment.memberId,
      serviceId: appointment.serviceId,
      selection: quote.selection,
      allowance: quote.allowance,
      actorId: String(actor(req)._id),
      target: { appointmentId: appointment._id },
    },
    session
  );
}

function assertOwnProvider(req: Request, providerId: string) {
  if (req.permission?.scope === "own" && providerId !== String(actor(req)._id))
    throw new ForbiddenError("Own-scope staff can only book their own appointments");
}

interface BookBody {
  memberId: string;
  serviceId: string;
  providerId: string;
  locationId: string;
  startAt: Date;
  deliveryMethod: string;
  episodeId?: string;
  reason?: string;
  reasonDetail?: string;
  memberNote?: string;
  bookingSource: string;
  idempotencyKey?: string;
  expectedQuote?: ExpectedQuote;
}

async function replay(
  organizationId: string,
  body: BookBody,
  session: ClientSession | null = null
) {
  if (!body.idempotencyKey) return null;
  const existing = await Appointment.findOne({
    organizationId,
    idempotencyKey: body.idempotencyKey,
  }).session(session);
  if (!existing) return null;
  const same =
    String(existing.memberId) === body.memberId &&
    String(existing.serviceId) === body.serviceId &&
    String(existing.providerId) === body.providerId &&
    String(existing.locationId) === body.locationId &&
    existing.startAt.getTime() === body.startAt.getTime();
  if (!same)
    throw new ConflictError(
      "This idempotency key was used for a different booking",
      undefined,
      "IDEMPOTENCY_KEY_REUSED"
    );
  return existing;
}

async function createBooking(req: Request, body: BookBody, session: ClientSession) {
  const staff = actor(req);
  // Re-checked under the member lock: a same-key writer that committed first wins.
  const prior = await replay(staff.organizationId, body, session);
  if (prior) return { appointment: prior, replayed: true };
  const quoted = await buildQuote(staff.organizationId, body, session);
  const { quote, service, location } = quoted;
  if (service.bundleComponentIds.length)
    throw new ValidationError(
      "Start an assessment episode, then book its components",
      "BUNDLE_REQUIRES_EPISODE"
    );
  assertBookable(quote);
  assertEpisodeComponent(quote, body.episodeId);
  assertExpected(quote, body.expectedQuote);
  const endAt = await assertSlot(
    quoted,
    { ...body, organizationId: staff.organizationId },
    session
  );
  const [appointment] = await Appointment.create(
    [
      {
        organizationId: staff.organizationId,
        memberId: body.memberId,
        serviceId: service._id,
        categoryId: service.categoryId,
        providerId: body.providerId,
        locationId: location._id,
        marketId: quoted.marketId,
        episodeId: body.episodeId ?? null,
        startAt: body.startAt,
        endAt,
        durationMinutes: service.durationMinutes,
        timeZone: location.timeZone ?? "America/Los_Angeles",
        deliveryMethod: body.deliveryMethod,
        modality: service.modality ?? "physical",
        reason: body.reason,
        reasonDetail: body.reasonDetail,
        memberNote: body.memberNote,
        bookingSource: body.bookingSource,
        bookedById: staff._id,
        idempotencyKey: body.idempotencyKey,
        price: priceOf(quote),
        ...paymentFields(quote.finalCents),
        statusHistory: [{ status: "booked", at: new Date(), byId: staff._id }],
      },
    ],
    { session }
  );
  if (!appointment) throw new AppError("Appointment was not created");
  await reserveIfAllowance(req, quote, appointment, session);
  await enqueueForMember(body.memberId, (account) => bookingCreated(account, appointment), session);
  await audit(req, "created", "Appointment", String(appointment._id), body.memberId, session);
  return { appointment, replayed: false };
}

export async function bookAppointment(req: Request) {
  const body = req.body as BookBody;
  assertOwnProvider(req, body.providerId);
  const member = await scopedMember(req, body.memberId, true);
  const existing = await replay(member.organizationId, body);
  if (existing) return { appointment: existing, replayed: true };
  try {
    const result = await lockedTransaction(
      [
        memberLock(body.memberId),
        providerLock(body.providerId),
        ...(await roomLocks(body.serviceId)),
      ],
      (session) => createBooking(req, body, session)
    );
    if (!result.replayed)
      await appointmentChanged("appointment_booked", result.appointment, actor(req)._id);
    return result;
  } catch (error) {
    // A concurrent request with the same key committed first.
    const again =
      (error as { code?: number }).code === 11000 && (await replay(member.organizationId, body));
    if (again) return { appointment: again, replayed: true };
    throw error;
  }
}

/** Appointment in the org and the actor's APPOINTMENTS/MEMBER_RECORDS scope, or 404. */
export async function appointmentTarget(req: Request, session: ClientSession | null = null) {
  const staff = actor(req);
  const row = await Appointment.findOne({
    _id: req.params["id"],
    organizationId: staff.organizationId,
    ...(req.permission?.scope === "own" ? { providerId: staff._id } : {}),
  }).session(session);
  if (!row) throw new NotFoundError("Appointment not found");
  await scopedMember(req, String(row.memberId));
  return row;
}

interface RescheduleBody {
  startAt: Date;
  providerId?: string;
  deliveryMethod?: string;
  expectedQuote?: ExpectedQuote;
}
export async function rescheduleAppointment(req: Request) {
  const body = req.body as RescheduleBody;
  const initial = await appointmentTarget(req);
  const providerId = body.providerId ?? String(initial.providerId);
  assertOwnProvider(req, providerId);
  const keys = [
    memberLock(initial.memberId),
    providerLock(initial.providerId),
    providerLock(providerId),
    ...(await roomLocks(initial.serviceId)),
  ];
  const moved = await lockedTransaction([...new Set(keys)], async (session) => {
    const row = await Appointment.findById(initial._id).session(session);
    if (!row || !["booked", "confirmed"].includes(row.status))
      throw new ValidationError(
        "Only booked or confirmed appointments can be rescheduled",
        "INVALID_STATUS_TRANSITION"
      );
    const staffId = String(actor(req)._id);
    // Released first so the re-quote sees this booking's own unit as available.
    await ledger.settle({ appointmentId: row._id }, "released", staffId, "rescheduled", session);
    const input = {
      memberId: String(row.memberId),
      serviceId: String(row.serviceId),
      locationId: String(row.locationId),
      startAt: body.startAt,
      deliveryMethod: body.deliveryMethod ?? row.deliveryMethod ?? STANDARD_DELIVERY,
      episodeId: row.episodeId ? String(row.episodeId) : null,
      excludeAppointmentId: row._id,
    };
    const quoted = await buildQuote(row.organizationId, input, session);
    assertBookable(quoted.quote);
    assertEpisodeComponent(quoted.quote, input.episodeId);
    assertExpected(quoted.quote, body.expectedQuote);
    const endAt = await assertSlot(
      quoted,
      { ...input, organizationId: row.organizationId, providerId, excludeId: row._id },
      session
    );
    const previousStartAt = row.startAt;
    row.set({
      startAt: body.startAt,
      endAt,
      providerId,
      deliveryMethod: input.deliveryMethod,
      marketId: quoted.marketId,
      price: priceOf(quoted.quote),
      ...paymentFields(quoted.quote.finalCents),
    });
    await row.save({ session });
    await reserveIfAllowance(req, quoted.quote, row, session);
    await enqueueForMember(
      row.memberId,
      (account) => bookingRescheduled(account, row, previousStartAt),
      session
    );
    await audit(req, "rescheduled", "Appointment", String(row._id), String(row.memberId), session);
    return row;
  });
  const providers = [...new Set([String(initial.providerId), String(moved.providerId)])];
  await appointmentChanged("appointment_rescheduled", moved, actor(req)._id, providers);
  return moved;
}
