// Builds the central entitlement request from real data: W5 memberships, the
// W6 ledger usage, the location's market and the (server-loaded) assessment
// episode, then calls the pure W4r evaluator.
import type { Request } from "express";
import type { ClientSession } from "mongoose";
import { AppError, ConflictError, NotFoundError } from "../../common/errors/AppError.js";
import { audit } from "../audit/audit.js";
import { Market } from "../catalog/catalog.model.js";
import type { EntitlementQuote, EpisodeContext } from "../entitlement/entitlement.types.js";
import { STANDARD_DELIVERY } from "../entitlement/entitlement.types.js";
import { evaluateEntitlement } from "../entitlement/evaluate.js";
import { loadCatalogSnapshot } from "../entitlement/snapshot.js";
import { MemberMembership } from "../member/member.model.js";
import { Member } from "../member/member.model.js";
import { memberScope } from "../member/member.scope.js";
import { toHolding } from "../member/membership.service.js";
import { Appointment, AssessmentEpisode, LIVE_STATUSES } from "./appointment.model.js";
import { bookableLocation, bookableService } from "./availability.service.js";
import { ledger } from "./ledger.service.js";

export interface QuoteInput {
  memberId: string;
  serviceId: string;
  locationId: string;
  startAt: Date;
  deliveryMethod: string;
  episodeId?: string | null;
  excludeAppointmentId?: unknown;
}
/** What is stored on a booking: the quote without the per-candidate provenance list. */
export type PriceSnapshot = Omit<EntitlementQuote, "candidates">;
export const priceOf = ({ candidates: C, ...price }: EntitlementQuote): PriceSnapshot => price;
const PAID_EPISODE = new Set(["retail", "discount", "custom"]);
const MEMBERSHIP_DECISIONS = new Set(["allowance", "included"]);

/** The member in the body, within the actor's MEMBER_RECORDS scope (404 otherwise). */
export async function scopedMember(req: Request, memberId: string, write = false) {
  const member = await Member.findOne({ _id: memberId, ...(await memberScope(req)) });
  if (!member) throw new NotFoundError("Member not found");
  if (write && member.archivedAt)
    throw new ConflictError("Archived members cannot be booked", undefined, "MEMBER_ARCHIVED");
  return member;
}

export async function episodeContext(
  organizationId: string,
  memberId: string,
  episodeId: string,
  excludeAppointmentId: unknown,
  session: ClientSession | null
): Promise<EpisodeContext> {
  const episode = await AssessmentEpisode.findOne({ _id: episodeId, organizationId, memberId })
    .session(session)
    .lean();
  if (!episode) throw new NotFoundError("Assessment episode not found");
  if (episode.status !== "open")
    throw new ConflictError("This assessment is no longer open", undefined, "EPISODE_NOT_OPEN");
  const claimed = await Appointment.distinct("serviceId", {
    organizationId,
    episodeId: episode._id,
    status: { $in: LIVE_STATUSES },
    ...(excludeAppointmentId ? { _id: { $ne: excludeAppointmentId } } : {}),
  }).session(session);
  const purchased = PAID_EPISODE.has(String((episode.price as PriceSnapshot).decision));
  return {
    id: String(episode._id),
    bundleServiceId: String(episode.bundleServiceId),
    membershipId: purchased || !episode.membershipId ? null : String(episode.membershipId),
    benefitId: purchased ? null : (episode.benefitId ?? null),
    purchased,
    fulfilledServiceIds: claimed.map(String),
  };
}

export async function buildQuote(
  organizationId: string,
  input: QuoteInput,
  session: ClientSession | null = null,
  now = new Date()
) {
  const service = await bookableService(organizationId, input.serviceId);
  const location = await bookableLocation(organizationId, input.locationId);
  const market = await Market.findOne({ organizationId, locationIds: location._id })
    .sort({ active: -1, _id: 1 })
    .session(session)
    .lean();
  const rows = await MemberMembership.find({ organizationId, memberId: input.memberId })
    .session(session)
    .lean();
  const holdings = rows.map(toHolding);
  const snapshot = await loadCatalogSnapshot(organizationId);
  const episode = input.episodeId
    ? await episodeContext(
        organizationId,
        input.memberId,
        input.episodeId,
        input.excludeAppointmentId,
        session
      )
    : undefined;
  const usage = await ledger.usage(
    organizationId,
    input.memberId,
    holdings,
    snapshot.plans,
    input.startAt,
    { appointmentId: input.excludeAppointmentId as string | undefined },
    session
  );
  const quote = evaluateEntitlement(snapshot, {
    serviceId: input.serviceId,
    marketId: market ? String(market._id) : null,
    deliveryMethod: input.deliveryMethod,
    at: input.startAt,
    now,
    memberships: holdings,
    usage,
    ...(episode ? { episode } : {}),
  });
  return { quote, service, location, marketId: market?._id ?? null };
}

export function assertBookable(quote: EntitlementQuote) {
  if (!quote.bookable)
    throw new AppError(
      "This service cannot be booked for this member here",
      422,
      true,
      { quote: priceOf(quote) },
      quote.denialReason ?? "NOT_BOOKABLE"
    );
}
export interface ExpectedQuote {
  finalCents: number | null;
  ruleVersion: string;
}
/** Staff confirmed a price; booking re-evaluates and refuses if it moved. */
export function assertExpected(quote: EntitlementQuote, expected?: ExpectedQuote) {
  if (
    expected &&
    (expected.finalCents !== quote.finalCents || expected.ruleVersion !== quote.ruleVersion)
  )
    throw new ConflictError(
      "The price changed since it was quoted. Review the new quote.",
      { quote: priceOf(quote) },
      "QUOTE_CHANGED"
    );
}
export const holdsMembership = (quote: EntitlementQuote) =>
  MEMBERSHIP_DECISIONS.has(String(quote.decision));

/** POST /appointments/quote. A bundle is quoted as an episode (now, standard collection). */
export async function quote(req: Request) {
  const body = req.body as QuoteInput & { appointmentId?: string };
  const organizationId = (await scopedMember(req, body.memberId)).organizationId;
  const service = await bookableService(organizationId, body.serviceId);
  const bundle = service.bundleComponentIds.length > 0;
  const result = await buildQuote(organizationId, {
    ...body,
    startAt: bundle ? new Date() : body.startAt,
    deliveryMethod: bundle ? STANDARD_DELIVERY : body.deliveryMethod,
    episodeId: bundle ? null : (body.episodeId ?? null),
    excludeAppointmentId: body.appointmentId,
  });
  await audit(req, "quoted", "EntitlementQuote", body.serviceId, body.memberId);
  return { kind: bundle ? "episode" : "appointment", ...result.quote };
}
