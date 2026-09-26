// Plain-data contract for the pure entitlement evaluator. W6 loads these from
// Mongo (see snapshot.ts) and passes them in; nothing here touches a database.
export const OWNERS = ["aerwell", "everhaus"] as const;
export type Owner = (typeof OWNERS)[number];
export const PLAN_BRANDS = ["alfred", "aerwell", "everhaus"] as const;
export type PlanBrand = (typeof PLAN_BRANDS)[number];
export const BENEFIT_ACCESS = ["eligible", "ineligible", "exclusive"] as const;
export type BenefitAccess = (typeof BENEFIT_ACCESS)[number];
export const PRICING_MODES = ["retail", "discount", "custom", "included"] as const;
export type PricingMode = (typeof PRICING_MODES)[number];
export const PERIOD_UNITS = ["year", "quarter", "month"] as const;
export type PeriodUnit = (typeof PERIOD_UNITS)[number];
export const STANDARD_DELIVERY = "standard";
export const DEFAULT_CURRENCY = "USD";
export const QUOTE_TTL_MS = 15 * 60 * 1000;
export const BASIS_POINTS_PER_WHOLE = 10_000;

export interface BenefitPricing {
  mode: PricingMode;
  discountBps?: number;
  customPriceCents?: number;
}
export interface BenefitPeriodPolicy {
  unit: PeriodUnit;
  // Only "anniversary" (membership start) is supported: implementation default,
  // pending client confirmation. Allowances never roll over.
  anchor: "anniversary";
  rollover: "none";
}
export interface BenefitConfig {
  id: string;
  serviceId: string;
  access: BenefitAccess;
  includedQuantity: number;
  period: BenefitPeriodPolicy | null;
  exhaustion: "paid" | "deny";
  pricing: BenefitPricing;
}
export interface PlanConfig {
  id: string;
  version: number;
  status: "active" | "archived";
  isBaseline: boolean;
  clinicianChat: boolean;
  restrictedOwners: Owner[];
  benefits: BenefitConfig[];
}
export interface ServiceConfig {
  id: string;
  version: number;
  owner: Owner;
  status: "active" | "inactive" | "archived";
  retailCents: number | null;
  marketScope: "all" | "listed";
  marketIds: string[];
  bundleComponentIds: string[];
}
export interface MarketConfig {
  id: string;
  active: boolean;
}
export interface DeliveryModifierConfig {
  id: string;
  key: string;
  version: number;
  active: boolean;
  amountCents: number;
  serviceIds: string[];
  marketScope: "all" | "listed";
  marketIds: string[];
  chargeWhenIncluded: boolean;
}
export interface CatalogSnapshot {
  services: ServiceConfig[];
  markets: MarketConfig[];
  plans: PlanConfig[];
  modifiers: DeliveryModifierConfig[];
}
export interface MembershipHolding {
  id: string;
  planId: string;
  status: "active" | "past_due" | "paused" | "cancelled";
  startedAt: Date;
  endsAt?: Date | null;
}
/**
 * Server-loaded assessment episode (never client input). An allowance episode
 * names the membership benefit that reserved it; a purchased episode (the
 * bundle was quoted at a paid price) has no membership and sets `purchased`.
 * fulfilledServiceIds = components already claimed by a live booking.
 */
export interface EpisodeContext {
  id: string;
  bundleServiceId: string;
  membershipId: string | null;
  benefitId: string | null;
  purchased?: boolean;
  fulfilledServiceIds: string[];
}
export interface EntitlementRequest {
  serviceId: string;
  marketId: string | null;
  deliveryMethod: string;
  /** Appointment time: selects the benefit period. */
  at: Date;
  /** Quote time: sets quotedAt/expiresAt. */
  now: Date;
  memberships: MembershipHolding[];
  /** Units already reserved/used in the CURRENT period, keyed by usageKey(). */
  usage?: Record<string, number>;
  episode?: EpisodeContext;
  currency?: string;
}
export type DenialReason =
  | "SERVICE_NOT_FOUND"
  | "SERVICE_INACTIVE"
  | "MARKET_UNAVAILABLE"
  | "DELIVERY_UNAVAILABLE"
  | "NOT_ELIGIBLE"
  | "ALLOWANCE_EXHAUSTED"
  | "NOT_PURCHASABLE";
/** allowance = consumes one unit of a limited benefit; included = unlimited $0. */
export type Decision =
  | "allowance"
  | "included"
  | "episode_component"
  | "custom"
  | "discount"
  | "retail";
export interface AllowanceState {
  membershipId: string;
  benefitId: string;
  limit: number;
  usedBefore: number;
  remainingAfter: number;
  consumes: 0 | 1;
  periodStart: Date;
  /** Renewal date (exclusive end of the current period). */
  periodEnd: Date;
}
export interface Selection {
  membershipId: string | null;
  planId: string | null;
  benefitId: string | null;
}
export interface CandidateOutcome {
  selection: Selection;
  ok: boolean;
  denialReason: DenialReason | null;
  decision: Decision | null;
  priceCents: number | null;
  allowance: AllowanceState | null;
}
export interface FeeLine {
  modifierId: string;
  key: string;
  amountCents: number;
}
export interface EntitlementQuote {
  bookable: boolean;
  denialReason: DenialReason | null;
  serviceId: string;
  marketId: string | null;
  deliveryMethod: string;
  selection: Selection | null;
  decision: Decision | null;
  retailCents: number | null;
  priceCents: number | null;
  allowance: AllowanceState | null;
  fees: FeeLine[];
  feesCents: number;
  finalCents: number | null;
  currency: string;
  ruleVersion: string;
  quotedAt: Date;
  expiresAt: Date;
  /** Every membership considered, for provenance. */
  candidates: CandidateOutcome[];
}
