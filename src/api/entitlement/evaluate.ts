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
  membership: MembershipHolding | null;
  plan: PlanConfig | null;
}
const isCurrent = (m: MembershipHolding, at: Date) =>
  m.status === "active" && m.startedAt <= at && (!m.endsAt || at < m.endsAt);

function activeCandidates(catalog: CatalogSnapshot, req: EntitlementRequest): Candidate[] {
  const held = req.memberships.flatMap((membership) => {
    const plan = catalog.plans.find((p) => p.id === membership.planId && p.status === "active");
    return plan && isCurrent(membership, req.at) ? [{ membership, plan }] : [];
  });
  const baseline = catalog.plans.filter((p) => p.isBaseline && p.status === "active");
  const implicit = baseline.length
    ? baseline.map((plan) => ({ membership: null, plan }))
    : [{ membership: null, plan: null }];
  return [...held, ...implicit];
}

export function clinicianChatAllowed(
  plans: PlanConfig[],
  memberships: MembershipHolding[],
  at: Date
): boolean {
  return activeCandidates({ plans, services: [], markets: [], modifiers: [] }, {
    memberships,
    at,
  } as EntitlementRequest).some((c) => c.plan?.clinicianChat === true);
}

function offeredIn(service: ServiceConfig, catalog: CatalogSnapshot, marketId: string | null) {
  if (service.marketScope === "all") return true;
  const market = catalog.markets.find((m) => m.id === marketId);
  return !!market?.active && service.marketIds.includes(market.id);
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
  const benefit = candidate.plan?.benefits.find((b) => b.serviceId === service.id);
  const selection = {
    membershipId: candidate.membership?.id ?? null,
    planId: candidate.plan?.id ?? null,
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
  if (
    benefit?.access === "ineligible" ||
    (!benefit && candidate.plan?.restrictedOwners.includes(service.owner))
  )
    return fail("NOT_ELIGIBLE");
  const allowance =
    benefit && candidate.membership ? allowanceFor(benefit, candidate.membership, req) : null;
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
  const priced = priceFromPricing(service, benefit);
  if (!priced) return fail("NOT_PURCHASABLE");
  return { selection, ok: true, denialReason: null, ...priced, allowance };
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
  const holder = candidates.find((c) => c.membership?.id === episode.membershipId);
  if (!(bundle?.bundleComponentIds.includes(service.id) && holder)) return null;
  return {
    selection: {
      membershipId: episode.membershipId,
      planId: holder.plan?.id ?? null,
      benefitId: episode.benefitId,
    },
    ok: true,
    denialReason: null,
    decision: "episode_component",
    priceCents: 0,
    allowance: null,
  };
}

// Proposal (not client-approved): cheapest price wins; on a tie prefer not
// consuming a unit, then (when both consume) the pool that renews first, then a
// held membership over the baseline (keeps usage provenance), then stable ids.
function compareOutcomes(a: CandidateOutcome, b: CandidateOutcome): number {
  const bothConsume = a.allowance?.consumes === 1 && b.allowance?.consumes === 1;
  return (
    (a.priceCents ?? 0) - (b.priceCents ?? 0) ||
    (a.allowance?.consumes ?? 0) - (b.allowance?.consumes ?? 0) ||
    (bothConsume ? Number(a.allowance?.periodEnd) - Number(b.allowance?.periodEnd) : 0) ||
    Number(a.selection.membershipId === null) - Number(b.selection.membershipId === null) ||
    String(a.selection.membershipId ?? a.selection.planId).localeCompare(
      String(b.selection.membershipId ?? b.selection.planId)
    )
  );
}
const DENIAL_PRIORITY: DenialReason[] = ["ALLOWANCE_EXHAUSTED", "NOT_PURCHASABLE", "NOT_ELIGIBLE"];
const FREE_DECISIONS = new Set(["allowance", "included", "episode_component"]);

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
  if (![service, ...components].every((s) => s && offeredIn(s, catalog, req.marketId)))
    return deny("MARKET_UNAVAILABLE", version);
  const modifier = resolveModifier(catalog, req, service);
  if (modifier === "unavailable") return deny("DELIVERY_UNAVAILABLE", version);
  const candidates = activeCandidates(catalog, req);
  const outcomes = candidates.map((c) => evaluateCandidate(service, c, req));
  const episode = episodeOutcome(catalog, service, candidates, req);
  const valid = [...(episode ? [episode] : []), ...outcomes]
    .filter((o) => o.ok)
    .sort(compareOutcomes);
  const best = valid[0];
  if (!best) {
    const reason = DENIAL_PRIORITY.find((r) => outcomes.some((o) => o.denialReason === r));
    return deny(reason ?? "NOT_ELIGIBLE", version, outcomes);
  }
  const waived = !modifier?.chargeWhenIncluded && FREE_DECISIONS.has(String(best.decision));
  const fees =
    modifier && !waived
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
