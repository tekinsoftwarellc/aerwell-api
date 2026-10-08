import type { Request } from "express";
import type { ClientSession } from "mongoose";
import type { z } from "zod";
import { BadRequestError, NotFoundError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import {
  Appointment,
  type AppointmentDocument,
  AssessmentEpisode,
  LIVE_STATUSES,
} from "../appointment/appointment.model.js";
import { assertSlot, lockedTransaction, roomLocks } from "../appointment/booking.service.js";
import { memberLock, providerLock } from "../appointment/ledger.service.js";
import { audit } from "../audit/audit.js";
import { DeliveryModifier, Market } from "../catalog/catalog.model.js";
import { STANDARD_DELIVERY } from "../entitlement/entitlement.types.js";
import { Location } from "../location/location.model.js";
import { appointmentChanged } from "../notification/producers.js";
import { Service } from "../service/service.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { loadCatalogContext, offeredLocations } from "./catalogItem.js";
import { publishedService } from "./partner.availability.controller.js";
import { contractConflict, remapBookingError } from "./partner.errors.js";
import type { bookingBody } from "./partner.schema.js";
import { decodeSlotRef } from "./slotRef.js";

export type BookingBody = z.output<typeof bookingBody>;
const PARTNER_ACTOR = "partner:alfred-api";
/** The clinician review comes after the other assessment components (Q6). */
export const REVIEW_SLUG = "assessment-clinician-review";
const isDuplicate = (error: unknown) => (error as { code?: number }).code === 11000;

const outside = (message: string) => contractConflict("OUTSIDE_BOOKING_WINDOW", message);
const slotTaken = () => contractConflict("SLOT_TAKEN", "That time is no longer available");

/** Everything the body names, resolved: 404 for an unknown item, location or staff, SLOT_TAKEN for a bad ref. */
async function resolveTarget(organizationId: string, body: BookingBody) {
  const service = await publishedService(organizationId, body.itemRef);
  const location = objectId.safeParse(body.locationRef).success
    ? await Location.findOne({ _id: body.locationRef, organizationId })
    : null;
  if (!location) throw new NotFoundError("Unknown location");
  if (
    body.staffRef &&
    !(
      objectId.safeParse(body.staffRef).success &&
      (await StaffMember.exists({ _id: body.staffRef, organizationId }))
    )
  )
    throw new NotFoundError("Unknown staff member");
  const slot = decodeSlotRef(body.slotRef);
  const here =
    service.modality === "virtual" ||
    offeredLocations(service, await loadCatalogContext(organizationId)).includes(
      String(location._id)
    );
  // An unknown, stale or forged ref, a ref for another item or place, and a place the service is
  // not offered at are all the same answer: fetch availability again (contract §5.7).
  if (
    !(slot && here) ||
    slot.slug !== body.itemRef ||
    slot.locationId !== String(location._id) ||
    (body.staffRef && slot.providerId !== body.staffRef)
  )
    throw slotTaken();
  return { service, location, slot };
}

/** A non-standard method must be an active modifier that applies to this service in this market. */
async function assertDelivery(
  organizationId: string,
  method: string,
  service: { _id: unknown; marketScope?: string | null },
  marketId: unknown,
  bundleId?: unknown
) {
  if (method === STANDARD_DELIVERY) return;
  const modifier = await DeliveryModifier.findOne({ organizationId, slug: method, active: true });
  const covers = (id: unknown) => modifier?.serviceIds.some((s) => String(s) === String(id));
  const inMarket =
    modifier?.marketScope === "all" ||
    (marketId !== null && modifier?.marketIds.some((m) => String(m) === String(marketId)));
  if (!(modifier && (covers(service._id) || (bundleId && covers(bundleId))) && inMarket))
    throw new BadRequestError("Unsupported delivery method for this service");
}

/** Review ordering (Q6): it cannot start before the last other component ends, nor can one end after it starts. */
export async function assertReviewOrder(
  episodeId: unknown,
  service: { slug?: string | null },
  start: Date,
  end: Date,
  session: ClientSession,
  excludeId?: unknown
) {
  const siblings = await Appointment.find({
    episodeId,
    status: { $in: LIVE_STATUSES },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select("serviceId startAt endAt")
    .session(session)
    .lean();
  const slugs = new Map(
    (
      await Service.find({ _id: { $in: siblings.map((s) => s.serviceId) } })
        .select("slug")
        .lean()
    ).map((s) => [String(s._id), s.slug])
  );
  const others = siblings.filter((s) => slugs.get(String(s.serviceId)) !== REVIEW_SLUG);
  if (service.slug === REVIEW_SLUG) {
    const latest = Math.max(0, ...others.map((s) => s.endAt.getTime()));
    if (start.getTime() < latest)
      throw outside("The clinician review comes after the other assessment visits");
    return;
  }
  const review = siblings.find((s) => slugs.get(String(s.serviceId)) === REVIEW_SLUG);
  if (review && end > review.startAt)
    throw outside("This visit must finish before the clinician review");
}

/** The local episode for an Alfred assessment (find or create, keyed `alfred:<ref>`), with the component claimed once. */
async function claimEpisode(
  member: { _id: unknown; organizationId: string },
  input: NonNullable<BookingBody["episode"]>,
  service: { _id: unknown; slug?: string | null },
  placement: { locationId: unknown; marketId: unknown; start: Date; end: Date },
  session: ClientSession
) {
  const organizationId = member.organizationId;
  const bundle = await Service.findOne({
    organizationId,
    slug: input.bundleRef,
    deletedAt: null,
  }).session(session);
  if (!bundle?.bundleComponentIds.some((id) => String(id) === String(service._id)))
    throw new BadRequestError("This item is not a component of that assessment");
  const key = `alfred:${input.ref}`;
  const episode =
    (await AssessmentEpisode.findOne({ organizationId, idempotencyKey: key }).session(session)) ??
    (
      await AssessmentEpisode.create(
        [
          {
            organizationId,
            memberId: member._id,
            bundleServiceId: bundle._id,
            locationId: placement.locationId,
            marketId: placement.marketId,
            componentServiceIds: bundle.bundleComponentIds,
            // Alfred holds the bundle's price and its one unit; Aerwell records only that it came from Alfred.
            price: { source: "alfred", bundleRef: input.bundleRef },
            amountDueCents: 0,
            paymentStatus: "not_required",
            idempotencyKey: key,
          },
        ],
        { session }
      )
    )[0];
  if (!episode || String(episode.memberId) !== String(member._id))
    throw new NotFoundError("Assessment episode not found");
  if (episode.status !== "open") throw outside("This assessment is no longer open");
  const claimed = await Appointment.exists({
    episodeId: episode._id,
    serviceId: service._id,
    status: { $in: LIVE_STATUSES },
  }).session(session);
  if (claimed) throw contractConflict("ALREADY_BOOKED", "This visit is already booked");
  await assertReviewOrder(episode._id, service, placement.start, placement.end, session);
  return episode;
}

const paymentFieldsOf = (payment: BookingBody["payment"]) => ({
  amountDueCents: payment.amountCents,
  paymentStatus:
    payment.amountCents === 0
      ? "not_required"
      : payment.status === "paid"
        ? "paid_external"
        : "pending_external",
});

/**
 * Create a booking Alfred has already priced and (or will) charge. No quote, no plan, no allowance, no
 * delivery fee, no `PAYMENT_REQUIRED`, and nothing here touches Aerwell's own entitlement or ledger:
 * the amount, currency, intent and order reference are recorded and that is all. The slot goes through
 * the same check availability lists from, under the member, provider and room locks.
 */
export async function createAlfredBooking(req: Request, body: BookingBody, idempotencyKey: string) {
  const member = req.partnerMember;
  if (!member) throw new NotFoundError("Member not found");
  const organizationId = member.organizationId;
  const { service, location, slot } = await resolveTarget(organizationId, body);
  const delivery = body.deliveryMethod ?? STANDARD_DELIVERY;
  const market = await Market.findOne({ organizationId, locationIds: location._id, active: true })
    .sort({ _id: 1 })
    .select("_id")
    .lean();
  const marketId = market?._id ?? null;
  const key = `alfred:${idempotencyKey}`;
  const existing = (session: ClientSession | null = null) =>
    Appointment.findOne({ organizationId, memberId: member._id, idempotencyKey: key }).session(
      session
    );
  try {
    const result = await lockedTransaction(
      [memberLock(member._id), providerLock(slot.providerId), ...(await roomLocks(service._id))],
      async (session) => {
        const prior = await existing(session);
        if (prior) return { row: prior, replayed: true };
        const endAt = await assertSlot(
          { service, location },
          {
            organizationId,
            memberId: member._id,
            providerId: slot.providerId,
            startAt: slot.startAt,
            deliveryMethod: delivery,
          },
          session
        );
        const episode = body.episode
          ? await claimEpisode(
              member,
              body.episode,
              service,
              { locationId: location._id, marketId, start: slot.startAt, end: endAt },
              session
            )
          : null;
        await assertDelivery(organizationId, delivery, service, marketId, episode?.bundleServiceId);
        const [created] = await Appointment.create(
          [
            {
              organizationId,
              memberId: member._id,
              serviceId: service._id,
              categoryId: service.categoryId,
              providerId: slot.providerId,
              locationId: location._id,
              marketId,
              episodeId: episode?._id ?? null,
              startAt: slot.startAt,
              endAt,
              durationMinutes: service.durationMinutes,
              timeZone: location.timeZone ?? "America/Los_Angeles",
              deliveryMethod: delivery,
              modality: service.modality ?? "physical",
              memberNote: body.notes,
              bookingSource: "alfred_app",
              idempotencyKey: key,
              price: {
                source: "alfred",
                amountCents: body.payment.amountCents,
                currency: body.payment.currency,
                decision: body.entitlement?.decision,
                quoteRuleVersion: body.entitlement?.quoteRuleVersion,
                paymentIntentId: body.payment.paymentIntentId,
                alfredOrderRef: body.alfredOrderRef,
              },
              ...paymentFieldsOf(body.payment),
              externalPayment: {
                status: body.payment.status,
                amountCents: body.payment.amountCents,
                currency: body.payment.currency,
                paymentIntentId: body.payment.paymentIntentId,
              },
              alfredOrderRef: body.alfredOrderRef,
              acceptedTermsVersion: body.acceptedTermsVersion,
              serviceAddress: body.serviceAddress,
              statusHistory: [{ status: "booked", at: new Date() }],
            },
          ],
          { session }
        );
        if (!created) throw new Error("Appointment was not created");
        await audit(
          req,
          "created",
          "Appointment",
          String(created._id),
          String(member._id),
          session
        );
        return { row: created, replayed: false };
      }
    );
    if (!result.replayed) await appointmentChanged("appointment_booked", result.row, PARTNER_ACTOR);
    return result.row;
  } catch (error) {
    // A concurrent copy of this request committed first: answer with what it made.
    const again = isDuplicate(error) ? await existing() : null;
    if (again) return again;
    throw remapBookingError(error);
  }
}

/** A booking of the acting member, or 404. Staff-made bookings of a linked member are readable too. */
export async function ownedBooking(req: Request, bookingRef: string): Promise<AppointmentDocument> {
  const member = req.partnerMember;
  const row =
    member && objectId.safeParse(bookingRef).success
      ? await Appointment.findOne({
          _id: bookingRef,
          organizationId: member.organizationId,
          memberId: member._id,
        })
      : null;
  if (!row) throw new NotFoundError("Booking not found");
  return row;
}
