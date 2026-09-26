// Hand-maintained manifest for W6 appointments, availability, quotes,
// assessment episodes and the allowance ledger; the swagger drift test
// compares it with the mounted Express routes.
const error = { $ref: "#/components/schemas/ErrorResponse" };
const errors = {
  400: { description: "VALIDATION_ERROR", content: { "application/json": { schema: error } } },
  401: { description: "Staff session required" },
  403: {
    description:
      "Missing APPOINTMENTS (or MEMBER_RECORDS view) permission; own scope booking another provider; WAIVE_REQUIRES_MASTER",
  },
  404: { description: "Not found in the organization or the actor's scope" },
  409: {
    description:
      "SLOT_UNAVAILABLE, MEMBER_DOUBLE_BOOKED, QUOTE_CHANGED (data.quote = new server quote), IDEMPOTENCY_KEY_REUSED, STATUS_CHANGED, EPISODE_NOT_OPEN, EPISODE_IN_PROGRESS, EPISODE_COMPONENT_UNAVAILABLE, ALLOWANCE_ALREADY_HELD, MEMBER_ARCHIVED",
  },
  422: {
    description:
      "Entitlement denial as the code (MARKET_UNAVAILABLE, NOT_ELIGIBLE, ALLOWANCE_EXHAUSTED, NOT_PURCHASABLE, SERVICE_INACTIVE, DELIVERY_UNAVAILABLE); INVALID_STATUS_TRANSITION, PROVIDER_NOT_ELIGIBLE, SLOT_NOT_ALIGNED, BUNDLE_REQUIRES_EPISODE, NOT_A_BUNDLE, INVALID_DATE_RANGE, INVALID_LOCAL_TIME",
  },
};
const quoteSchema = {
  type: "object",
  description:
    "Central entitlement quote: bookable, denialReason, selection {membershipId, planId, benefitId}, decision allowance|included|episode_component|custom|discount|retail, retailCents, priceCents, allowance {limit, usedBefore, remainingAfter, periodStart, periodEnd}, fees[], feesCents, finalCents, currency, ruleVersion, quotedAt, expiresAt. Stored on the booking as the price snapshot.",
};
type Spec = [method: string, path: string, summary: string, extra?: Record<string, unknown>];
const ops: Spec[] = [
  [
    "get",
    "/appointments",
    "Calendar rows for local dates [from, to) in the location (or organization) time zone. categoryId[], serviceId, providerId, locationId, memberId, status[] (default: all but cancelled), q (member name), page, limit<=500. Own scope = own provider. Audited.",
  ],
  [
    "get",
    "/appointments/summary",
    "Per-day counts {days:[{date,count}], total} for month=YYYY-MM or from/to; same filters as the list. Audited.",
  ],
  [
    "post",
    "/appointments/quote",
    "Server quote from real memberships, ledger usage, market and episode (APPOINTMENTS view). A bundle service is quoted as an episode (kind=episode).",
    {
      responses: {
        200: {
          description: "Quote",
          content: { "application/json": { schema: quoteSchema } },
        },
      },
    },
  ],
  [
    "post",
    "/appointments",
    "Book (APPOINTMENTS edit): re-quotes, re-validates the slot and reserves allowance in one transaction under member+provider locks; expectedQuote mismatch -> 409 QUOTE_CHANGED; idempotencyKey replays return {replayed:true}. Price snapshot and amount due stored; payments unconfigured. Audited.",
  ],
  [
    "get",
    "/availability",
    "Open 15-minute slots per eligible provider: shifts at the location within business hours, minus approved PTO and live appointments, capacity-aware, local dates [from, to<=from+14).",
  ],
  [
    "get",
    "/appointments/{id}",
    "Detail with membership, visitsThisMonth, price snapshot, cancellationPreview, allowedTransitions. Audited.",
  ],
  [
    "post",
    "/appointments/{id}/reschedule",
    "Atomic re-evaluation: releases the held unit, re-quotes (geography, price, period), re-validates the slot, reserves again. Audited.",
  ],
  [
    "post",
    "/appointments/{id}/cancel",
    "Cancel with reason; late (inside lateCancellationFee.windowHours) records the fee as amount due, or forfeits a held unit instead; waiveFee needs APPOINTMENTS master. Audited.",
  ],
  [
    "patch",
    "/appointments/{id}/status",
    "booked->confirmed|checked_in|no_show, confirmed->checked_in|no_show, checked_in->in_progress|completed, in_progress->completed; else 422 INVALID_STATUS_TRANSITION. completed consumes the unit (episode: first component), no_show forfeits and raises an urgent attendance flag. Audited.",
  ],
  [
    "get",
    "/members/{id}/appointments",
    "Member appointments scope=upcoming|past|all, q (service title), page, limit. Audited.",
  ],
  [
    "post",
    "/assessment-episodes",
    "Open an Advanced Assessment episode: one quote (standard collection) and at most one allowance reservation shared by its components. Audited.",
  ],
  [
    "get",
    "/assessment-episodes/{id}",
    "Episode with its components, their live bookings and fulfilment. Audited.",
  ],
  [
    "post",
    "/assessment-episodes/{id}/cancel",
    "Cancel an episode with no completed component: cancels its component bookings and releases the unit. Audited.",
  ],
  ["get", "/members/{id}/assessment-episodes", "Member's assessment episodes. Audited."],
];
const params = (path: string) =>
  [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string", pattern: "^[a-f0-9]{24}$" },
  }));
export const appointmentPaths: Record<string, Record<string, unknown>> = {};
for (const [method, path, summary, extra] of ops) {
  const key = `/api/v1${path}`;
  appointmentPaths[key] = {
    ...appointmentPaths[key],
    [method]: {
      summary,
      tags: ["Appointments"],
      security: [{ staffBearer: [] }],
      parameters: params(path),
      responses: {
        200: { description: "Success envelope" },
        201: { description: "Created" },
        ...errors,
        ...(extra?.["responses"] as object),
      },
    },
  };
}
