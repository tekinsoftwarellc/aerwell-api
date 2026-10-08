// Pure, side-effect-free entitlement evaluation (CLIENT-CATALOG-ENTITLEMENTS
// "Central entitlement contract"). No database, no clock, no ledger writes:
// the caller supplies the catalog snapshot, memberships, current-period usage
// counts and both timestamps. W6 reserves allowance units transactionally.
import {
  type AllowanceState,
  BASIS_POINTS_PER_WHOLE,
  type BenefitConfig,
  type CandidateOutcome,
  type CatalogSnapshot,
  DEFAULT_CURRENCY,
  type DeliveryModifierConfig,
  type DenialReason,
  type EntitlementQuote,
  type EntitlementRequest,
  type MembershipHolding,
  type PlanConfig,
  QUOTE_TTL_MS,
  STANDARD_DELIVERY,
  type ServiceConfig,
} from "./entitlement.types.js";
import { benefitPeriod } from "./period.js";

export { benefitPeriod } from "./period.js";
export const usageKey = (membershipId: string, benefitId: string) => `${membershipId}:${benefitId}`;

/** Price after an integer basis-point discount; the discount rounds half up. */
export function applyBasisPoints(cents: number, bps: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new RangeError("cents must be a non-negative integer");
  if (!Number.isInteger(bps) || bps < 0 || bps > BASIS_POINTS_PER_WHOLE)
    throw new RangeError("bps must be an integer from 0 to 10000");
  const discount = Math.floor((cents * bps + BASIS_POINTS_PER_WHOLE / 2) / BASIS_POINTS_PER_WHOLE);
  return cents - discount;
}

interface Candidate {
  membership: MembershipHolding;
  plan: PlanConfig;
}
const isCurrent = (m: MembershipHolding, at: Date) =>
  m.status === "active" && m.startedAt <= at && (!m.endsAt || at < m.endsAt);

// Only memberships the member currently holds carry benefits. A member with
// none pays per use (see payPerUse).
function activeCandidates(plans: PlanConfig[], memberships: MembershipHolding[], at: Date) {
  return memberships.flatMap((membership): Candidate[] => {
    const plan = plans.find((p) => p.id === membership.planId && p.status === "active");
    return plan && isCurrent(membership, at) ? [{ membership, plan }] : [];
  });
}

export function clinicianChatAllowed(
  plans: PlanConfig[],
  memberships: MembershipHolding[],
  at: Date
): boolean {
  return activeCandidates(plans, memberships, at).some((c) => c.plan.clinicianChat);
}

/** null = member outside every configured market; unknown or inactive ids offer nothing. */
function marketUsable(catalog: CatalogSnapshot, marketId: string | null) {
  return marketId === null || !!catalog.markets.find((m) => m.id === marketId)?.active;
}
function offeredIn(service: ServiceConfig, marketId: string | null) {
  if (service.marketScope === "all") return true;
  return marketId !== null && service.marketIds.includes(marketId);
}

function resolveModifier(
  catalog: CatalogSnapshot,
  req: EntitlementRequest,
  service: ServiceConfig
): DeliveryModifierConfig | null | "unavailable" {
  if (req.deliveryMethod === STANDARD_DELIVERY) return null;
  const modifier = catalog.modifiers.find((m) => m.key === req.deliveryMethod && m.active);
  if (!modifier) return "unavailable";
  const applies = [service.id, ...service.bundleComponentIds].some((id) =>
    modifier.serviceIds.includes(id)
  );
  const inMarket =
    modifier.marketScope === "all" ||
    (req.marketId !== null && modifier.marketIds.includes(req.marketId));
  return applies && inMarket ? modifier : "unavailable";
}

function allowanceFor(
  benefit: BenefitConfig,
  membership: MembershipHolding,
  req: EntitlementRequest
): AllowanceState | null {
  if (benefit.includedQuantity <= 0 || !benefit.period) return null;
  const period = benefitPeriod(membership.startedAt, benefit.period, req.at);
  const used = req.usage?.[usageKey(membership.id, benefit.id)] ?? 0;
  const available = used < benefit.includedQuantity;
  return {
    membershipId: membership.id,
    benefitId: benefit.id,
    limit: benefit.includedQuantity,
    usedBefore: used,
    remainingAfter: Math.max(0, benefit.includedQuantity - used - (available ? 1 : 0)),
    consumes: available ? 1 : 0,
    periodStart: period.start,
    periodEnd: period.end,
  };
}

function priceFromPricing(
  service: ServiceConfig,
  benefit: BenefitConfig | undefined
): Pick<CandidateOutcome, "decision" | "priceCents"> | null {
  const pricing = benefit?.pricing ?? { mode: "retail" };
  if (pricing.mode === "included") return { decision: "included", priceCents: 0 };
  if (pricing.mode === "custom" && pricing.customPriceCents !== undefined)
    return { decision: "custom", priceCents: pricing.customPriceCents };
  if (service.retailCents === null) return null;
  if (pricing.mode === "discount")
    return {
      decision: "discount",
      priceCents: applyBasisPoints(service.retailCents, pricing.discountBps ?? 0),
    };
  return { decision: "retail", priceCents: service.retailCents };
}

function evaluateCandidate(
  service: ServiceConfig,
  candidate: Candidate,
  req: EntitlementRequest
): CandidateOutcome {
  const benefit = candidate.plan.benefits.find((b) => b.serviceId === service.id);
  const selection = {
    membershipId: candidate.membership.id,
    planId: candidate.plan.id,
    benefitId: benefit?.id ?? null,
  };
  const fail = (denialReason: DenialReason, allowance: AllowanceState | null = null) => ({
    selection,
    ok: false,
    denialReason,
    decision: null,
    priceCents: null,
    allowance,
  });
  if (benefit?.access === "ineligible") return fail("NOT_ELIGIBLE");
  const allowance = benefit ? allowanceFor(benefit, candidate.membership, req) : null;
  if (allowance?.consumes)
    return {
      selection,
      ok: true,
      denialReason: null,
      decision: "allowance",
      priceCents: 0,
      allowance,
    };
  if (allowance && benefit?.exhaustion === "deny") return fail("ALLOWANCE_EXHAUSTED", allowance);
  // Defence in depth (writes reject it): a spent allowance never prices at $0.
  const priced =
    allowance && benefit?.pricing.mode === "included"
      ? priceFromPricing(service, undefined)
      : priceFromPricing(service, benefit);
  if (!priced) return fail("NOT_PURCHASABLE");
  return { selection, ok: true, denialReason: null, ...priced, allowance };
}

// No current membership: the service is sold at retail, pay per use. A
// service without a retail price (a bundle-only component) cannot be bought.
function payPerUse(service: ServiceConfig): CandidateOutcome {
  const selection = { membershipId: null, planId: null, benefitId: null };
  const priced = priceFromPricing(service, undefined);
  return priced
    ? { selection, ok: true, denialReason: null, ...priced, allowance: null }
    : {
        selection,
        ok: false,
        denialReason: "NOT_PURCHASABLE",
        decision: null,
        priceCents: null,
        allowance: null,
      };
}

function episodeOutcome(
  catalog: CatalogSnapshot,
  service: ServiceConfig,
  candidates: Candidate[],
  req: EntitlementRequest
): CandidateOutcome | null {
  const episode = req.episode;
  if (!episode || episode.fulfilledServiceIds.includes(service.id)) return null;
  const bundle = catalog.services.find((s) => s.id === episode.bundleServiceId);
  if (!bundle?.bundleComponentIds.includes(service.id)) return null;
  if (episode.purchased && episode.membershipId === null)
    return {
      selection: { membershipId: null, planId: null, benefitId: null },
      ok: true,
      denialReason: null,
      decision: "episode_component",
      priceCents: 0,
      allowance: null,
    };
  const holder = candidates.find((c) => c.membership.id === episode.membershipId);
  const benefit = holder?.plan.benefits.find((b) => b.id === episode.benefitId);
  if (!benefit || benefit.serviceId !== bundle.id || benefit.access === "ineligible") return null;
  return {
    selection: {
      membershipId: episode.membershipId,
      planId: holder?.plan.id ?? null,
      benefitId: episode.benefitId,
    },
    ok: true,
    denialReason: null,
    decision: "episode_component",
    priceCents: 0,
    allowance: null,
  };
}

const FREE_DECISIONS = new Set(["allowance", "included", "episode_component"]);
const feeFor = (modifier: DeliveryModifierConfig | null, outcome: CandidateOutcome) =>
  !modifier || (!modifier.chargeWhenIncluded && FREE_DECISIONS.has(String(outcome.decision)))
    ? 0
    : modifier.amountCents;
// Proposal (not client-approved): lowest final amount (price + fee) wins; on a
// tie prefer not consuming a unit, then (when both consume) the pool that renews
// first, then a held membership over a purchased episode (provenance), then stable ids.
const compareOutcomes =
  (modifier: DeliveryModifierConfig | null) =>
  (a: CandidateOutcome, b: CandidateOutcome): number => {
    const bothConsume = a.allowance?.consumes === 1 && b.allowance?.consumes === 1;
    return (
      (a.priceCents ?? 0) + feeFor(modifier, a) - ((b.priceCents ?? 0) + feeFor(modifier, b)) ||
      (a.allowance?.consumes ?? 0) - (b.allowance?.consumes ?? 0) ||
      (bothConsume ? Number(a.allowance?.periodEnd) - Number(b.allowance?.periodEnd) : 0) ||
      Number(a.selection.membershipId === null) - Number(b.selection.membershipId === null) ||
      String(a.selection.membershipId ?? a.selection.planId).localeCompare(
        String(b.selection.membershipId ?? b.selection.planId)
      )
    );
  };
const DENIAL_PRIORITY: DenialReason[] = ["ALLOWANCE_EXHAUSTED", "NOT_PURCHASABLE", "NOT_ELIGIBLE"];

function ruleVersion(
  service: ServiceConfig,
  plan: PlanConfig | null | undefined,
  modifier: DeliveryModifierConfig | null
) {
  return [
    `service:${service.id}@${service.version}`,
    ...(plan ? [`plan:${plan.id}@${plan.version}`] : []),
    ...(modifier ? [`modifier:${modifier.id}@${modifier.version}`] : []),
  ].join(";");
}

export function evaluateEntitlement(
  catalog: CatalogSnapshot,
  req: EntitlementRequest
): EntitlementQuote {
  const base = {
    serviceId: req.serviceId,
    marketId: req.marketId,
    deliveryMethod: req.deliveryMethod,
    currency: req.currency ?? DEFAULT_CURRENCY,
    quotedAt: req.now,
    expiresAt: new Date(req.now.getTime() + QUOTE_TTL_MS),
  };
  const deny = (
    denialReason: DenialReason,
    version = "",
    candidates: CandidateOutcome[] = []
  ): EntitlementQuote => ({
    ...base,
    bookable: false,
    denialReason,
    selection: null,
    decision: null,
    retailCents: null,
    priceCents: null,
    allowance: null,
    fees: [],
    feesCents: 0,
    finalCents: null,
    ruleVersion: version,
    candidates,
  });
  const service = catalog.services.find((s) => s.id === req.serviceId);
  if (!service) return deny("SERVICE_NOT_FOUND");
  const version = ruleVersion(service, null, null);
  const components = service.bundleComponentIds.map((id) =>
    catalog.services.find((s) => s.id === id)
  );
  if (service.status !== "active" || components.some((c) => c?.status !== "active"))
    return deny("SERVICE_INACTIVE", version);
  if (
    !marketUsable(catalog, req.marketId) ||
    ![service, ...components].every((s) => s && offeredIn(s, req.marketId))
  )
    return deny("MARKET_UNAVAILABLE", version);
  const modifier = resolveModifier(catalog, req, service);
  if (modifier === "unavailable") return deny("DELIVERY_UNAVAILABLE", version);
  const candidates = activeCandidates(catalog.plans, req.memberships, req.at);
  const outcomes = candidates.length
    ? candidates.map((c) => evaluateCandidate(service, c, req))
    : [payPerUse(service)];
  const episode = episodeOutcome(catalog, service, candidates, req);
  const valid = [...(episode ? [episode] : []), ...outcomes]
    .filter((o) => o.ok)
    .sort(compareOutcomes(modifier));
  const best = valid[0];
  if (!best) {
    const reason = DENIAL_PRIORITY.find((r) => outcomes.some((o) => o.denialReason === r));
    return deny(reason ?? "NOT_ELIGIBLE", version, outcomes);
  }
  const fees =
    modifier && feeFor(modifier, best) > 0
      ? [{ modifierId: modifier.id, key: modifier.key, amountCents: modifier.amountCents }]
      : [];
  const feesCents = fees.reduce((sum, f) => sum + f.amountCents, 0);
  const plan = catalog.plans.find((p) => p.id === best.selection.planId);
  return {
    ...base,
    bookable: true,
    denialReason: null,
    selection: best.selection,
    decision: best.decision,
    retailCents: service.retailCents,
    priceCents: best.priceCents,
    allowance: best.allowance,
    fees,
    feesCents,
    finalCents: (best.priceCents ?? 0) + feesCents,
    ruleVersion: ruleVersion(service, plan, modifier),
    candidates: episode ? [episode, ...outcomes] : outcomes,
  };
}
