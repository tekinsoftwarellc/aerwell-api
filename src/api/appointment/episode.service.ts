// Advanced Assessment episodes: one quote and at most one allowance unit for
// the bundle; components are booked separately inside the episode at $0 plus
// their own delivery fee (so mobile phlebotomy is charged once, on the blood draw).
import type { Request } from "express";
import type { ClientSession } from "mongoose";
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import { STANDARD_DELIVERY } from "../entitlement/entitlement.types.js";
import { memberTarget } from "../member/member.scope.js";
import { Service } from "../service/service.model.js";
import { Appointment, AssessmentEpisode, LIVE_STATUSES } from "./appointment.model.js";
import { lockedTransaction, paymentFields } from "./booking.service.js";
import { ledger, memberLock } from "./ledger.service.js";
import {
  type ExpectedQuote,
  assertBookable,
  assertExpected,
  buildQuote,
  holdsMembership,
  priceOf,
  scopedMember,
} from "./quote.service.js";

interface EpisodeBody {
  memberId: string;
  bundleServiceId: string;
  locationId: string;
  idempotencyKey?: string;
  expectedQuote?: ExpectedQuote;
}

async function openEpisode(req: Request, body: EpisodeBody, session: ClientSession) {
  const staff = actor(req);
  const { quote, service, location, marketId } = await buildQuote(
    staff.organizationId,
    {
      memberId: body.memberId,
      serviceId: body.bundleServiceId,
      locationId: body.locationId,
      startAt: new Date(),
      // The episode carries no delivery fee: fees belong to each component booking.
      deliveryMethod: STANDARD_DELIVERY,
    },
    session
  );
  if (!service.bundleComponentIds.length)
    throw new ValidationError("Only a bundle service opens an episode", "NOT_A_BUNDLE");
  assertBookable(quote);
  assertExpected(quote, body.expectedQuote);
  const membership = holdsMembership(quote);
  const [episode] = await AssessmentEpisode.create(
    [
      {
        organizationId: staff.organizationId,
        memberId: body.memberId,
        bundleServiceId: service._id,
        locationId: location._id,
        marketId,
        membershipId: membership ? quote.selection?.membershipId : null,
        benefitId: membership ? quote.selection?.benefitId : null,
        componentServiceIds: service.bundleComponentIds,
        price: priceOf(quote),
        ...paymentFields(quote.finalCents),
        idempotencyKey: body.idempotencyKey,
        createdById: staff._id,
      },
    ],
    { session }
  );
  if (!episode) throw new AppError("Episode was not created");
  if (quote.decision === "allowance" && quote.allowance && quote.selection)
    await ledger.reserve(
      {
        organizationId: staff.organizationId,
        memberId: body.memberId,
        serviceId: service._id,
        selection: quote.selection,
        allowance: quote.allowance,
        actorId: String(staff._id),
        target: { episodeId: episode._id },
      },
      session
    );
  await audit(req, "created", "AssessmentEpisode", String(episode._id), body.memberId, session);
  return episode;
}

export async function createEpisode(req: Request) {
  const body = req.body as EpisodeBody;
  const member = await scopedMember(req, body.memberId, true);
  const find = () =>
    body.idempotencyKey
      ? AssessmentEpisode.findOne({
          organizationId: member.organizationId,
          idempotencyKey: body.idempotencyKey,
        })
      : null;
  const existing = await find();
  if (existing) {
    if (String(existing.memberId) !== body.memberId)
      throw new ConflictError("Idempotency key reused", undefined, "IDEMPOTENCY_KEY_REUSED");
    return { episode: existing, replayed: true };
  }
  try {
    const episode = await lockedTransaction([memberLock(body.memberId)], (session) =>
      openEpisode(req, body, session)
    );
    return { episode, replayed: false };
  } catch (error) {
    const again = (error as { code?: number }).code === 11000 && (await find());
    if (again) return { episode: again, replayed: true };
    throw error;
  }
}

async function episodeTarget(req: Request) {
  const episode = await AssessmentEpisode.findOne({
    _id: req.params["id"],
    organizationId: actor(req).organizationId,
  });
  if (!episode) throw new NotFoundError("Assessment episode not found");
  await scopedMember(req, String(episode.memberId));
  return episode;
}

async function withComponents(episode: InstanceType<typeof AssessmentEpisode>) {
  const [services, bookings] = await Promise.all([
    Service.find({ _id: { $in: [episode.bundleServiceId, ...episode.componentServiceIds] } })
      .select("title durationMinutes")
      .lean(),
    Appointment.find({ episodeId: episode._id, status: { $in: LIVE_STATUSES } })
      .select("serviceId startAt status providerId")
      .lean(),
  ]);
  const title = (id: unknown) => services.find((s) => String(s._id) === String(id))?.title ?? null;
  return {
    ...episode.toObject(),
    bundleTitle: title(episode.bundleServiceId),
    components: episode.componentServiceIds.map((id) => ({
      serviceId: String(id),
      title: title(id),
      fulfilled: episode.fulfilledServiceIds.some((f) => String(f) === String(id)),
      appointment: bookings.find((b) => String(b.serviceId) === String(id)) ?? null,
    })),
  };
}

export async function getEpisode(req: Request) {
  const episode = await episodeTarget(req);
  await audit(req, "viewed", "AssessmentEpisode", String(episode._id), String(episode.memberId));
  return withComponents(episode);
}

export async function memberEpisodes(req: Request) {
  const member = await memberTarget(req);
  const episodes = await AssessmentEpisode.find({
    organizationId: member.organizationId,
    memberId: member._id,
  }).sort({ createdAt: -1, _id: -1 });
  await audit(req, "viewed", "AssessmentEpisodes", String(member._id), String(member._id));
  return { items: await Promise.all(episodes.map(withComponents)) };
}

/** Cancels an untouched episode: its component bookings are cancelled and the unit released. */
export async function cancelEpisode(req: Request) {
  const initial = await episodeTarget(req);
  const reason = (req.body as { reason: string }).reason;
  return lockedTransaction([memberLock(initial.memberId)], async (session) => {
    const episode = await AssessmentEpisode.findById(initial._id).session(session);
    if (episode?.status !== "open")
      throw new ConflictError("This assessment is no longer open", undefined, "EPISODE_NOT_OPEN");
    if (episode.fulfilledServiceIds.length)
      throw new ConflictError(
        "A component was already completed; the assessment cannot be cancelled",
        undefined,
        "EPISODE_IN_PROGRESS"
      );
    const staff = actor(req);
    const now = new Date();
    await Appointment.updateMany(
      { episodeId: episode._id, status: { $in: ["booked", "confirmed", "checked_in"] } },
      {
        $set: {
          status: "cancelled",
          cancellation: {
            at: now,
            byId: staff._id,
            reason,
            late: false,
            feeCents: 0,
            allowance: "none",
          },
          amountDueCents: 0,
          paymentStatus: "not_required",
        },
        $push: { statusHistory: { status: "cancelled", at: now, byId: staff._id } },
      },
      { session }
    );
    await ledger.settle({ episodeId: episode._id }, "released", String(staff._id), reason, session);
    episode.set({
      status: "cancelled",
      cancelledAt: now,
      amountDueCents: 0,
      paymentStatus: "not_required",
    });
    await episode.save({ session });
    await audit(
      req,
      "cancelled",
      "AssessmentEpisode",
      String(episode._id),
      String(episode.memberId),
      session
    );
    return episode;
  });
}
