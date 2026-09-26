// Initial client catalog (CLIENT-CATALOG-ENTITLEMENTS-2026-09-26.md). This is
// SEED DATA only: every value is editable through the API/admin afterwards and
// no booking logic reads these constants.
import type {
  BenefitAccess,
  BenefitPricing,
  Owner,
  PeriodUnit,
  PlanBrand,
} from "../entitlement/entitlement.types.js";

export interface SeedService {
  slug: string;
  title: string;
  owner: Owner;
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
  brand: PlanBrand;
  priceCents: number | null;
  billingTerm: "monthly" | null;
  isBaseline: boolean;
  clinicianChat: boolean;
  restrictedOwners: Owner[];
  benefits: SeedBenefit[];
}

// Categories beyond the six Figma ones: the client catalog has clinician visits
// and Everhaus services that fit none of them.
export const extraCategories = [
  { name: "Clinician visits", color: "#8b4c27" },
  { name: "Everhaus wellness", color: "#de8201" },
];

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
  owner: "aerwell",
  category,
  retailCents,
  modality,
  marketScope: lasVegasOnly ? "listed" : "all",
  marketKeys: lasVegasOnly ? ["las-vegas"] : [],
  bundle,
  description: "",
});
// Everhaus services are physical; market assumed Las Vegas until confirmed.
const everhaus = (slug: string, title: string, retailCents: number | null): SeedService => ({
  slug,
  title,
  owner: "everhaus",
  category: "Everhaus wellness",
  retailCents,
  modality: "physical",
  marketScope: "listed",
  marketKeys: ["las-vegas"],
  bundle: [],
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
  everhaus("red-light-therapy", "Red Light Therapy", 6000),
  everhaus("hyperbaric-oxygen-therapy", "Hyperbaric Oxygen Therapy", 15000),
  everhaus("autonomous-massage-therapy", "Autonomous Massage Therapy", 10000),
  everhaus("everhaus-training", "Everhaus Training", 7500),
  everhaus("personal-training", "One-on-One Personal Training", 15000),
  {
    ...everhaus("sanctuary", "Sanctuary", null),
    description: "Sauna, steam, cold plunge, hot tub and hammam.",
  },
];

const EVERHAUS_DISCOUNTED = [
  "red-light-therapy",
  "hyperbaric-oxygen-therapy",
  "autonomous-massage-therapy",
  "everhaus-training",
  "personal-training",
];
const allowance = (service: string, quantity: number, periodUnit: PeriodUnit): SeedBenefit => ({
  service,
  access: "eligible",
  includedQuantity: quantity,
  periodUnit,
  exhaustion: "paid",
  pricing: { mode: "retail" },
});
const priced = (
  service: string,
  pricing: BenefitPricing,
  access: BenefitAccess = "eligible"
): SeedBenefit => ({
  service,
  access,
  includedQuantity: 0,
  periodUnit: null,
  exhaustion: "paid",
  pricing,
});
const aerwellPlan = (
  slug: string,
  name: string,
  priceCents: number,
  quantity: number,
  discountBps: number
): SeedPlan => ({
  slug,
  name,
  brand: "aerwell",
  priceCents,
  billingTerm: "monthly",
  isBaseline: false,
  clinicianChat: true,
  restrictedOwners: [],
  benefits: [
    allowance("advanced-assessment", quantity, "year"),
    allowance("clinician-telehealth-visit", quantity, "year"),
    ...EVERHAUS_DISCOUNTED.map((s) => priced(s, { mode: "discount", discountBps })),
    priced("sanctuary", { mode: "retail" }, "ineligible"),
  ],
});

export const seedPlans: SeedPlan[] = [
  {
    slug: "alfred-free",
    name: "Alfred Free",
    brand: "alfred",
    priceCents: 0,
    billingTerm: null,
    isBaseline: true,
    clinicianChat: false,
    restrictedOwners: ["everhaus"],
    benefits: [],
  },
  aerwellPlan("aerwell-essential", "Aerwell Essential", 19900, 2, 1000),
  aerwellPlan("aerwell-continuum", "Aerwell Continuum", 29900, 4, 2000),
  {
    slug: "everhaus-member",
    name: "Everhaus Member",
    brand: "everhaus",
    priceCents: null,
    billingTerm: null,
    isBaseline: false,
    clinicianChat: true,
    restrictedOwners: [],
    benefits: [
      // "4 per year, quarterly benefit": one per quarter; rollover unconfirmed.
      allowance("advanced-assessment", 1, "quarter"),
      ...EVERHAUS_DISCOUNTED.slice(0, 4).map((s) => priced(s, { mode: "included" })),
      priced("personal-training", { mode: "custom", customPriceCents: 10000 }),
      priced("sanctuary", { mode: "included" }, "exclusive"),
    ],
  },
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
