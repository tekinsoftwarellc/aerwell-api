// Initial client catalog (CLIENT-CATALOG-ENTITLEMENTS-2026-09-26.md). This is
// SEED DATA only: every value is editable through the API/admin afterwards and
// no booking logic reads these constants.
import type {
  BenefitAccess,
  BenefitPricing,
  PeriodUnit,
} from "../entitlement/entitlement.types.js";

export interface SeedService {
  slug: string;
  title: string;
  category: string;
  retailCents: number | null;
  modality: "physical" | "virtual";
  marketScope: "all" | "listed";
  marketKeys: string[];
  bundle: string[];
  description: string;
}
export interface SeedBenefit {
  service: string;
  access: BenefitAccess;
  includedQuantity: number;
  periodUnit: PeriodUnit | null;
  exhaustion: "paid" | "deny";
  pricing: BenefitPricing;
}
export interface SeedPlan {
  slug: string;
  name: string;
  priceCents: number | null;
  billingTerm: "monthly" | null;
  clinicianChat: boolean;
  benefits: SeedBenefit[];
}

// Category beyond the six Figma ones: the client catalog has clinician visits.
export const extraCategories = [{ name: "Clinician visits", color: "#8b4c27" }];

export const seedMarkets = [{ key: "las-vegas", name: "Las Vegas", active: true }];

const aerwell = (
  slug: string,
  title: string,
  category: string,
  retailCents: number | null,
  modality: "physical" | "virtual",
  lasVegasOnly: boolean,
  bundle: string[] = []
): SeedService => ({
  slug,
  title,
  category,
  retailCents,
  modality,
  marketScope: lasVegasOnly ? "listed" : "all",
  marketKeys: lasVegasOnly ? ["las-vegas"] : [],
  bundle,
  description: "",
});
export const seedServices: SeedService[] = [
  aerwell(
    "comprehensive-blood-panel",
    "Comprehensive Blood Panel",
    "Cardiometabolic",
    59500,
    "physical",
    false
  ),
  aerwell("dexa-scan", "DEXA Scan", "Body composition", 17500, "physical", true),
  aerwell("vo2-max-test", "VO2 Max Test", "Performance & diagnostic", 17500, "physical", true),
  aerwell(
    "clinician-telehealth-visit",
    "Aerwell Clinician Telehealth Visit",
    "Clinician visits",
    25000,
    "virtual",
    false
  ),
  // Distinct from the standalone telehealth visit; not sold on its own.
  aerwell(
    "assessment-clinician-review",
    "Assessment Clinician Review",
    "Clinician visits",
    null,
    "virtual",
    false
  ),
  aerwell(
    "advanced-assessment",
    "Advanced Assessment",
    "Performance & diagnostic",
    99500,
    "physical",
    false,
    ["comprehensive-blood-panel", "dexa-scan", "vo2-max-test", "assessment-clinician-review"]
  ),
];

const allowance = (service: string, quantity: number, periodUnit: PeriodUnit): SeedBenefit => ({
  service,
  access: "eligible",
  includedQuantity: quantity,
  periodUnit,
  exhaustion: "paid",
  pricing: { mode: "retail" },
});
const aerwellPlan = (
  slug: string,
  name: string,
  priceCents: number,
  quantity: number
): SeedPlan => ({
  slug,
  name,
  priceCents,
  billingTerm: "monthly",
  clinicianChat: true,
  benefits: [
    allowance("advanced-assessment", quantity, "year"),
    allowance("clinician-telehealth-visit", quantity, "year"),
  ],
});

export const seedPlans: SeedPlan[] = [
  aerwellPlan("aerwell-essential", "Aerwell Essential", 19900, 2),
  aerwellPlan("aerwell-continuum", "Aerwell Continuum", 29900, 4),
];

export const seedModifiers = [
  {
    key: "mobile_phlebotomy",
    name: "Mobile phlebotomy",
    amountCents: 12000,
    serviceSlugs: ["comprehensive-blood-panel"],
    marketScope: "all" as const,
    marketKeys: [] as string[],
    chargeWhenIncluded: true,
    active: true,
  },
];
