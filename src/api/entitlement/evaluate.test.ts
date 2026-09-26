import { describe, expect, it } from "vitest";
import {
  seedMarkets,
  seedModifiers,
  seedPlans,
  seedServices,
} from "../catalog/catalog.seed-data.js";
import type {
  BenefitConfig,
  CatalogSnapshot,
  EntitlementRequest,
  MembershipHolding,
  PlanConfig,
} from "./entitlement.types.js";
import {
  applyBasisPoints,
  benefitPeriod,
  clinicianChatAllowed,
  evaluateEntitlement,
  usageKey,
} from "./evaluate.js";

// Snapshot built from the SAME seed data the database seed uses (ids = slugs),
// so these tests pin the client's numbers against the shipped configuration.
function seedSnapshot(): CatalogSnapshot {
  return {
    markets: [
      ...seedMarkets.map((m) => ({ id: m.key, active: m.active })),
      { id: "new-york", active: true },
    ],
    services: seedServices.map((s) => ({
      id: s.slug,
      version: 1,
      owner: s.owner,
      status: "active",
      retailCents: s.retailCents,
      marketScope: s.marketScope,
      marketIds: s.marketKeys,
      bundleComponentIds: s.bundle,
    })),
    plans: seedPlans.map((p) => ({
      id: p.slug,
      version: 1,
      status: "active",
      isBaseline: p.isBaseline,
      clinicianChat: p.clinicianChat,
      restrictedOwners: p.restrictedOwners,
      benefits: p.benefits.map((b) => ({
        id: b.service,
        serviceId: b.service,
        access: b.access,
        includedQuantity: b.includedQuantity,
        period: b.periodUnit
          ? { unit: b.periodUnit, anchor: "anniversary", rollover: "none" }
          : null,
        exhaustion: b.exhaustion,
        pricing: b.pricing,
      })),
    })),
    modifiers: seedModifiers.map((m) => ({
      id: m.key,
      key: m.key,
      version: 1,
      active: m.active,
      amountCents: m.amountCents,
      serviceIds: m.serviceSlugs,
      marketScope: m.marketScope,
      marketIds: m.marketKeys,
      chargeWhenIncluded: m.chargeWhenIncluded,
    })),
  };
}
const START = new Date("2026-01-15T08:00:00.000Z");
const AT = new Date("2026-03-01T17:00:00.000Z");
const NOW = new Date("2026-02-20T12:00:00.000Z");
const hold = (
  planId: string,
  startedAt = START,
  extra: Partial<MembershipHolding> = {}
): MembershipHolding => ({
  id: `m-${planId}`,
  planId,
  status: "active",
  startedAt,
  ...extra,
});
const ask = (
  serviceId: string,
  plans: string[],
  extra: Partial<EntitlementRequest> = {},
  catalog = seedSnapshot()
) =>
  evaluateEntitlement(catalog, {
    serviceId,
    marketId: "las-vegas",
    deliveryMethod: "standard",
    at: AT,
    now: NOW,
    memberships: plans.map((p) => hold(p)),
    ...extra,
  });
const ESSENTIAL = ["aerwell-essential"];
const CONTINUUM = ["aerwell-continuum"];
const EVERHAUS = ["everhaus-member"];
const EVERHAUS_SERVICES = [
  "red-light-therapy",
  "hyperbaric-oxygen-therapy",
  "autonomous-massage-therapy",
  "everhaus-training",
  "personal-training",
  "sanctuary",
];

describe("acceptance: Free / DTC", () => {
  it.each([
    ["comprehensive-blood-panel", 59500],
    ["dexa-scan", 17500],
    ["vo2-max-test", 17500],
    ["clinician-telehealth-visit", 25000],
    ["advanced-assessment", 99500],
  ])("Free + Las Vegas %s costs %i at retail", (service, cents) => {
    const q = ask(service, []);
    expect(q).toMatchObject({
      bookable: true,
      decision: "retail",
      retailCents: cents,
      finalCents: cents,
    });
    expect(q.selection).toMatchObject({ membershipId: null, planId: "alfred-free" });
  });
  it.each([
    ["comprehensive-blood-panel", 71500],
    ["advanced-assessment", 111500],
  ])("Free + Las Vegas mobile phlebotomy adds 12000 to %s", (service, cents) => {
    const q = ask(service, [], { deliveryMethod: "mobile_phlebotomy" });
    expect(q).toMatchObject({ bookable: true, feesCents: 12000, finalCents: cents });
    expect(q.fees).toEqual([
      { modifierId: "mobile_phlebotomy", key: "mobile_phlebotomy", amountCents: 12000 },
    ]);
  });
  it.each(["new-york", null])(
    "Free + %s: DEXA, VO2 and the assessment are unavailable",
    (marketId) => {
      for (const service of ["dexa-scan", "vo2-max-test", "advanced-assessment"])
        expect(ask(service, [], { marketId })).toMatchObject({
          bookable: false,
          denialReason: "MARKET_UNAVAILABLE",
          finalCents: null,
        });
      expect(ask("comprehensive-blood-panel", [], { marketId }).finalCents).toBe(59500);
      expect(ask("clinician-telehealth-visit", [], { marketId }).finalCents).toBe(25000);
    }
  );
  it.each(["las-vegas", "new-york"])(
    "Free in %s has no Everhaus checkout, even with a retail price",
    (marketId) => {
      for (const service of EVERHAUS_SERVICES) {
        const q = ask(service, [], { marketId });
        expect(q.bookable).toBe(false);
        expect(q.finalCents).toBeNull();
      }
      expect(ask("red-light-therapy", []).denialReason).toBe("NOT_ELIGIBLE");
    }
  );
});

describe("acceptance: paid memberships", () => {
  it.each([
    [ESSENTIAL, "red-light-therapy", 5400],
    [ESSENTIAL, "hyperbaric-oxygen-therapy", 13500],
    [ESSENTIAL, "autonomous-massage-therapy", 9000],
    [ESSENTIAL, "everhaus-training", 6750],
    [ESSENTIAL, "personal-training", 13500],
    [CONTINUUM, "red-light-therapy", 4800],
    [CONTINUUM, "hyperbaric-oxygen-therapy", 12000],
    [CONTINUUM, "autonomous-massage-therapy", 8000],
    [CONTINUUM, "everhaus-training", 6000],
    [CONTINUUM, "personal-training", 12000],
  ])("%j %s costs %i", (plans, service, cents) => {
    expect(ask(service, plans)).toMatchObject({
      bookable: true,
      decision: "discount",
      finalCents: cents,
    });
  });
  it.each([[ESSENTIAL], [CONTINUUM]])("%j is denied Sanctuary", (plans) => {
    expect(ask("sanctuary", plans)).toMatchObject({
      bookable: false,
      denialReason: "NOT_ELIGIBLE",
    });
  });
  it("Everhaus includes red light, hyperbaric, massage, training and Sanctuary; PT costs 10000", () => {
    for (const service of EVERHAUS_SERVICES.filter((s) => s !== "personal-training"))
      expect(ask(service, EVERHAUS)).toMatchObject({
        bookable: true,
        decision: "included",
        finalCents: 0,
      });
    expect(ask("personal-training", EVERHAUS)).toMatchObject({
      decision: "custom",
      finalCents: 10000,
    });
  });
  it("Everhaus included assessment with mobile collection charges only the 12000 fee", () => {
    const q = ask("advanced-assessment", EVERHAUS, { deliveryMethod: "mobile_phlebotomy" });
    expect(q).toMatchObject({
      decision: "allowance",
      priceCents: 0,
      feesCents: 12000,
      finalCents: 12000,
    });
  });
  it("an episode's blood component is included and only the mobile fee is charged, once", () => {
    const episode = {
      id: "ep-1",
      bundleServiceId: "advanced-assessment",
      membershipId: "m-everhaus-member",
      benefitId: "advanced-assessment",
      fulfilledServiceIds: [] as string[],
    };
    const first = ask("comprehensive-blood-panel", EVERHAUS, {
      deliveryMethod: "mobile_phlebotomy",
      episode,
    });
    expect(first).toMatchObject({
      decision: "episode_component",
      priceCents: 0,
      finalCents: 12000,
      allowance: null,
    });
    const standard = ask("comprehensive-blood-panel", EVERHAUS, { episode });
    expect(standard.finalCents).toBe(0);
    const repeat = ask("comprehensive-blood-panel", EVERHAUS, {
      episode: { ...episode, fulfilledServiceIds: ["comprehensive-blood-panel"] },
    });
    expect(repeat).toMatchObject({ decision: "retail", finalCents: 59500 });
    const foreign = ask("comprehensive-blood-panel", [], { episode });
    expect(foreign.decision).toBe("retail");
    expect(ask("red-light-therapy", EVERHAUS, { episode }).decision).toBe("included");
  });
});

describe("acceptance: allowances", () => {
  const assessment = (plans: string[], used: number, extra: Partial<EntitlementRequest> = {}) =>
    ask("advanced-assessment", plans, {
      usage: { [usageKey(`m-${plans[0]}`, "advanced-assessment")]: used },
      ...extra,
    });
  it.each([
    [ESSENTIAL, 0, 1],
    [ESSENTIAL, 1, 0],
    [CONTINUUM, 0, 3],
    [CONTINUUM, 3, 0],
  ])("%j assessment with %i used is included, %i remaining after", (plans, used, remaining) => {
    const q = assessment(plans, used);
    expect(q).toMatchObject({ decision: "allowance", finalCents: 0 });
    expect(q.allowance).toMatchObject({ usedBefore: used, remainingAfter: remaining, consumes: 1 });
  });
  it.each([
    [ESSENTIAL, 2],
    [CONTINUUM, 4],
  ])("%j next eligible assessment after %i costs 99500 with renewal date", (plans, used) => {
    const q = assessment(plans, used);
    expect(q).toMatchObject({ decision: "retail", finalCents: 99500 });
    expect(q.allowance).toMatchObject({
      usedBefore: used,
      remainingAfter: 0,
      consumes: 0,
      periodStart: START,
      periodEnd: new Date("2027-01-15T08:00:00.000Z"),
    });
  });
  it.each([
    [ESSENTIAL, 2],
    [CONTINUUM, 4],
  ])("%j clinician visits are a separate pool of %i", (plans, limit) => {
    const exhaustedAssessments = { [usageKey(`m-${plans[0]}`, "advanced-assessment")]: limit };
    const visit = (used: number) =>
      ask("clinician-telehealth-visit", plans, {
        usage: {
          ...exhaustedAssessments,
          [usageKey(`m-${plans[0]}`, "clinician-telehealth-visit")]: used,
        },
      });
    expect(visit(limit - 1)).toMatchObject({ decision: "allowance", finalCents: 0 });
    expect(visit(limit)).toMatchObject({ decision: "retail", finalCents: 25000 });
  });
  it("Everhaus assessment allowance is one per anniversary quarter", () => {
    const q = assessment(EVERHAUS, 0);
    expect(q.allowance).toMatchObject({
      limit: 1,
      periodStart: START,
      periodEnd: new Date("2026-04-15T08:00:00.000Z"),
    });
    expect(assessment(EVERHAUS, 1).finalCents).toBe(99500);
  });
  it("deny-on-exhaustion refuses that benefit but never leaves the member worse off than baseline", () => {
    const catalog = seedSnapshot();
    const essential = catalog.plans.find((p) => p.id === "aerwell-essential") as PlanConfig;
    essential.benefits = essential.benefits.map((b) =>
      b.id === "advanced-assessment" ? { ...b, exhaustion: "deny" } : b
    );
    const usage = { "m-aerwell-essential:advanced-assessment": 2 };
    const q = ask("advanced-assessment", ESSENTIAL, { usage }, catalog);
    expect(q).toMatchObject({ bookable: true, decision: "retail", finalCents: 99500 });
    expect(q.selection?.planId).toBe("alfred-free");
    expect(q.candidates.find((c) => c.selection.planId === "aerwell-essential")?.denialReason).toBe(
      "ALLOWANCE_EXHAUSTED"
    );
  });
});

describe("acceptance: overlapping memberships", () => {
  it("chooses the best single benefit and never stacks discounts", () => {
    const both = [...ESSENTIAL, ...CONTINUUM];
    const q = ask("red-light-therapy", both);
    expect(q).toMatchObject({ finalCents: 4800, decision: "discount" });
    expect(q.selection?.planId).toBe("aerwell-continuum");
    expect(q.candidates.filter((c) => c.ok)).toHaveLength(2);
    // Same answer regardless of the order memberships arrive in.
    expect(ask("red-light-therapy", [...CONTINUUM, ...ESSENTIAL]).finalCents).toBe(4800);
    expect(ask("personal-training", [...ESSENTIAL, ...EVERHAUS]).finalCents).toBe(10000);
    expect(ask("sanctuary", [...ESSENTIAL, ...EVERHAUS])).toMatchObject({
      bookable: true,
      finalCents: 0,
    });
  });
  it("uses another membership's allowance when one pool is exhausted, then retail", () => {
    const both = [...ESSENTIAL, ...CONTINUUM];
    const usage = {
      "m-aerwell-essential:advanced-assessment": 2,
      "m-aerwell-continuum:advanced-assessment": 1,
    };
    const q = ask("advanced-assessment", both, { usage });
    expect(q).toMatchObject({ decision: "allowance", finalCents: 0 });
    expect(q.selection?.membershipId).toBe("m-aerwell-continuum");
    const spent = { ...usage, "m-aerwell-continuum:advanced-assessment": 4 };
    expect(ask("advanced-assessment", both, { usage: spent })).toMatchObject({
      decision: "retail",
      finalCents: 99500,
    });
  });
  it("with two open pools, consumes the one that renews first (proposal)", () => {
    const early = hold("aerwell-essential", new Date("2025-04-01T00:00:00.000Z"));
    const late = hold("aerwell-continuum", new Date("2025-12-01T00:00:00.000Z"));
    for (const memberships of [
      [early, late],
      [late, early],
    ])
      expect(ask("advanced-assessment", [], { memberships }).selection?.membershipId).toBe(
        early.id
      );
  });
});

describe("acceptance: configuration edits change quotes without code edits", () => {
  it("Continuum allowance 4 -> 6 makes the fifth assessment included", () => {
    const usage = { "m-aerwell-continuum:advanced-assessment": 4 };
    expect(ask("advanced-assessment", CONTINUUM, { usage }).finalCents).toBe(99500);
    const catalog = seedSnapshot();
    const continuum = catalog.plans.find((p) => p.id === "aerwell-continuum") as PlanConfig;
    continuum.benefits = continuum.benefits.map((b) =>
      b.id === "advanced-assessment" ? { ...b, includedQuantity: 6 } : b
    );
    continuum.version = 2;
    const q = ask("advanced-assessment", CONTINUUM, { usage }, catalog);
    expect(q).toMatchObject({ decision: "allowance", finalCents: 0 });
    expect(q.ruleVersion).toContain("plan:aerwell-continuum@2");
  });
  it("mobile fee 12000 -> 15000 changes the quote", () => {
    const catalog = seedSnapshot();
    catalog.modifiers = catalog.modifiers.map((m) => ({ ...m, amountCents: 15000, version: 2 }));
    const q = ask(
      "comprehensive-blood-panel",
      [],
      { deliveryMethod: "mobile_phlebotomy" },
      catalog
    );
    expect(q).toMatchObject({ feesCents: 15000, finalCents: 74500 });
    expect(q.ruleVersion).toContain("modifier:mobile_phlebotomy@2");
  });
});

describe("availability, delivery and state guards", () => {
  it("rejects unknown, inactive and archived services and bundles with an inactive component", () => {
    expect(ask("missing", []).denialReason).toBe("SERVICE_NOT_FOUND");
    for (const status of ["inactive", "archived"] as const) {
      const catalog = seedSnapshot();
      catalog.services = catalog.services.map((s) => (s.id === "dexa-scan" ? { ...s, status } : s));
      expect(ask("dexa-scan", [], {}, catalog).denialReason).toBe("SERVICE_INACTIVE");
      expect(ask("advanced-assessment", EVERHAUS, {}, catalog).denialReason).toBe(
        "SERVICE_INACTIVE"
      );
      expect(ask("comprehensive-blood-panel", [], {}, catalog).bookable).toBe(true);
    }
  });
  it("applies geography to included benefits and honours inactive markets", () => {
    expect(ask("advanced-assessment", EVERHAUS, { marketId: "new-york" }).denialReason).toBe(
      "MARKET_UNAVAILABLE"
    );
    const catalog = seedSnapshot();
    catalog.markets = catalog.markets.map((m) =>
      m.id === "las-vegas" ? { ...m, active: false } : m
    );
    expect(ask("dexa-scan", [], {}, catalog).denialReason).toBe("MARKET_UNAVAILABLE");
    catalog.markets.push({ id: "reno", active: true });
    catalog.services = catalog.services.map((s) =>
      s.id === "dexa-scan" ? { ...s, marketIds: ["reno"] } : s
    );
    expect(ask("dexa-scan", [], { marketId: "reno" }, catalog).finalCents).toBe(17500);
  });
  it("rejects unknown, inapplicable, inactive and out-of-market delivery methods", () => {
    expect(ask("comprehensive-blood-panel", [], { deliveryMethod: "drone" }).denialReason).toBe(
      "DELIVERY_UNAVAILABLE"
    );
    expect(ask("dexa-scan", [], { deliveryMethod: "mobile_phlebotomy" }).denialReason).toBe(
      "DELIVERY_UNAVAILABLE"
    );
    const inactive = seedSnapshot();
    inactive.modifiers = inactive.modifiers.map((m) => ({ ...m, active: false }));
    expect(
      ask("comprehensive-blood-panel", [], { deliveryMethod: "mobile_phlebotomy" }, inactive)
        .denialReason
    ).toBe("DELIVERY_UNAVAILABLE");
    const listed = seedSnapshot();
    listed.modifiers = listed.modifiers.map((m) => ({
      ...m,
      marketScope: "listed",
      marketIds: ["las-vegas"],
    }));
    const mobile = { deliveryMethod: "mobile_phlebotomy" };
    expect(ask("comprehensive-blood-panel", [], mobile, listed).finalCents).toBe(71500);
    expect(
      ask("comprehensive-blood-panel", [], { ...mobile, marketId: "new-york" }, listed).denialReason
    ).toBe("DELIVERY_UNAVAILABLE");
  });
  it("waives an included fee only when the modifier says so, and never discounts it", () => {
    expect(
      ask("comprehensive-blood-panel", ESSENTIAL, { deliveryMethod: "mobile_phlebotomy" }).feesCents
    ).toBe(12000);
    const catalog = seedSnapshot();
    catalog.modifiers = catalog.modifiers.map((m) => ({ ...m, chargeWhenIncluded: false }));
    const mobile = { deliveryMethod: "mobile_phlebotomy" };
    expect(ask("advanced-assessment", EVERHAUS, mobile, catalog)).toMatchObject({
      feesCents: 0,
      finalCents: 0,
    });
    expect(ask("advanced-assessment", [], mobile, catalog).feesCents).toBe(12000);
  });
  it("ignores memberships that are not active at the appointment time or whose plan is archived", () => {
    for (const extra of [
      { status: "cancelled" as const },
      { status: "past_due" as const },
      { endsAt: new Date("2026-02-01T00:00:00.000Z") },
    ])
      expect(
        ask("red-light-therapy", [], { memberships: [hold("aerwell-essential", START, extra)] })
          .bookable
      ).toBe(false);
    expect(
      ask("red-light-therapy", [], {
        memberships: [hold("aerwell-essential", new Date("2026-06-01T00:00:00.000Z"))],
      }).bookable
    ).toBe(false);
    const catalog = seedSnapshot();
    catalog.plans = catalog.plans.map((p) =>
      p.id === "aerwell-essential" ? { ...p, status: "archived" } : p
    );
    expect(ask("red-light-therapy", ESSENTIAL, {}, catalog).bookable).toBe(false);
    expect(ask("red-light-therapy", ["unknown-plan"]).bookable).toBe(false);
  });
  it("refuses member-only services without a retail price to non-holders", () => {
    expect(ask("assessment-clinician-review", []).denialReason).toBe("NOT_PURCHASABLE");
    const noRetail = seedSnapshot();
    noRetail.services = noRetail.services.map((s) =>
      s.id === "red-light-therapy" ? { ...s, retailCents: null } : s
    );
    expect(ask("red-light-therapy", ESSENTIAL, {}, noRetail).denialReason).toBe("NOT_PURCHASABLE");
  });
  it("prefers exhaustion over price or eligibility when explaining a denial", () => {
    const catalog = seedSnapshot();
    catalog.plans = catalog.plans.map((p) =>
      p.id === "aerwell-essential"
        ? {
            ...p,
            benefits: p.benefits.map((b) =>
              b.id === "advanced-assessment" ? { ...b, exhaustion: "deny" as const } : b
            ),
          }
        : { ...p, restrictedOwners: ["aerwell" as const] }
    );
    const q = ask(
      "advanced-assessment",
      ESSENTIAL,
      { usage: { "m-aerwell-essential:advanced-assessment": 9 } },
      catalog
    );
    expect(q.denialReason).toBe("ALLOWANCE_EXHAUSTED");
    expect(q.allowance).toBeNull();
    expect(
      q.candidates.find((c) => c.denialReason === "ALLOWANCE_EXHAUSTED")?.allowance?.remainingAfter
    ).toBe(0);
  });
  it("stamps currency, a 15 minute expiry and every rule version it used", () => {
    const q = ask("comprehensive-blood-panel", ESSENTIAL, {
      deliveryMethod: "mobile_phlebotomy",
      currency: "USD",
    });
    expect(q.currency).toBe("USD");
    expect(q.quotedAt).toEqual(NOW);
    expect(q.expiresAt).toEqual(new Date(NOW.getTime() + 15 * 60 * 1000));
    expect(q.ruleVersion).toBe(
      "service:comprehensive-blood-panel@1;plan:aerwell-essential@1;modifier:mobile_phlebotomy@1"
    );
    expect(ask("missing", []).ruleVersion).toBe("");
  });
});

describe("money and periods", () => {
  it.each([
    [7500, 1000, 6750],
    [15000, 2000, 12000],
    [5, 1000, 4], // 0.5 cent discount rounds half up in the member's favour
    [12345, 1500, 10493], // discount 1851.75 -> 1852
    [999, 0, 999],
    [999, 10000, 0],
    [0, 5000, 0],
  ])("applyBasisPoints(%i, %i) = %i", (cents, bps, expected) => {
    expect(applyBasisPoints(cents, bps)).toBe(expected);
  });
  it.each([
    [1.5, 1000],
    [-1, 1000],
    [100, 10001],
    [100, 1.2],
  ])("applyBasisPoints rejects %d cents at %d bps", (cents, bps) => {
    expect(() => applyBasisPoints(cents, bps)).toThrow(RangeError);
  });
  it("computes anniversary periods from the original anchor with month-end clamping", () => {
    const policy = (unit: "year" | "quarter" | "month") => ({
      unit,
      anchor: "anniversary" as const,
      rollover: "none" as const,
    });
    const jan31 = new Date("2026-01-31T10:00:00.000Z");
    expect(benefitPeriod(jan31, policy("month"), new Date("2026-02-28T12:00:00.000Z"))).toEqual({
      start: new Date("2026-02-28T10:00:00.000Z"),
      end: new Date("2026-03-31T10:00:00.000Z"),
    });
    expect(
      benefitPeriod(jan31, policy("month"), new Date("2026-02-28T09:00:00.000Z")).start
    ).toEqual(jan31);
    const leap = new Date("2028-02-29T00:00:00.000Z");
    expect(benefitPeriod(leap, policy("year"), new Date("2029-03-01T00:00:00.000Z"))).toEqual({
      start: new Date("2029-02-28T00:00:00.000Z"),
      end: new Date("2030-02-28T00:00:00.000Z"),
    });
    expect(benefitPeriod(START, policy("quarter"), new Date("2026-10-20T00:00:00.000Z"))).toEqual({
      start: new Date("2026-10-15T08:00:00.000Z"),
      end: new Date("2027-01-15T08:00:00.000Z"),
    });
    expect(
      benefitPeriod(START, policy("year"), new Date("2025-06-01T00:00:00.000Z")).start
    ).toEqual(START);
    expect(
      benefitPeriod(START, policy("year"), new Date("2027-01-15T08:00:00.000Z")).start
    ).toEqual(new Date("2027-01-15T08:00:00.000Z"));
  });
  it("derives clinician chat from any qualifying active membership", () => {
    const { plans } = seedSnapshot();
    expect(clinicianChatAllowed(plans, [], AT)).toBe(false);
    expect(clinicianChatAllowed(plans, [hold("aerwell-essential")], AT)).toBe(true);
    expect(clinicianChatAllowed(plans, [hold("everhaus-member")], AT)).toBe(true);
    expect(
      clinicianChatAllowed(plans, [hold("aerwell-essential", START, { status: "cancelled" })], AT)
    ).toBe(false);
  });
});

describe("review regressions", () => {
  const withBenefit = (planId: string, serviceId: string, patch: Partial<BenefitConfig>) => {
    const catalog = seedSnapshot();
    catalog.plans = catalog.plans.map((p) =>
      p.id === planId
        ? {
            ...p,
            benefits: [
              ...p.benefits.filter((b) => b.serviceId !== serviceId),
              {
                id: serviceId,
                serviceId,
                access: "eligible",
                includedQuantity: 0,
                period: null,
                exhaustion: "paid",
                pricing: { mode: "retail" },
                ...patch,
              },
            ],
          }
        : p
    );
    return catalog;
  };
  it("fails closed for non-members when no baseline plan is active", () => {
    for (const status of ["archived", "missing"]) {
      const catalog = seedSnapshot();
      catalog.plans =
        status === "missing"
          ? catalog.plans.filter((p) => !p.isBaseline)
          : catalog.plans.map((p) => (p.isBaseline ? { ...p, status: "archived" } : p));
      for (const service of ["red-light-therapy", "dexa-scan", "sanctuary"])
        expect(ask(service, [], {}, catalog)).toMatchObject({
          bookable: false,
          denialReason: "NOT_ELIGIBLE",
        });
      expect(ask("red-light-therapy", ESSENTIAL, {}, catalog).finalCents).toBe(5400);
    }
  });
  it("an exhausted allowance never falls through to free pricing", () => {
    const catalog = withBenefit("aerwell-essential", "clinician-telehealth-visit", {
      includedQuantity: 2,
      period: { unit: "year", anchor: "anniversary", rollover: "none" },
      pricing: { mode: "included" },
    });
    const usage = { "m-aerwell-essential:clinician-telehealth-visit": 50 };
    expect(ask("clinician-telehealth-visit", ESSENTIAL, { usage }, catalog)).toMatchObject({
      decision: "retail",
      finalCents: 25000,
    });
  });
  it("ignores an episode whose benefit is not the holder's benefit for that bundle", () => {
    const episode = {
      id: "ep",
      bundleServiceId: "advanced-assessment",
      membershipId: "m-aerwell-essential",
      benefitId: "advanced-assessment",
      fulfilledServiceIds: [] as string[],
    };
    expect(ask("dexa-scan", ESSENTIAL, { episode }).decision).toBe("episode_component");
    for (const benefitId of ["anything", "clinician-telehealth-visit"])
      expect(ask("dexa-scan", ESSENTIAL, { episode: { ...episode, benefitId } }).decision).toBe(
        "retail"
      );
    const cancelled = { memberships: [hold("aerwell-essential", START, { status: "cancelled" })] };
    expect(ask("dexa-scan", [], { ...cancelled, episode }).decision).toBe("retail");
  });
  it("a purchased (retail) episode covers its unclaimed components without any membership", () => {
    const episode = {
      id: "ep-retail",
      bundleServiceId: "advanced-assessment",
      membershipId: null,
      benefitId: null,
      purchased: true,
      fulfilledServiceIds: ["dexa-scan"],
    };
    expect(ask("vo2-max-test", [], { episode })).toMatchObject({
      decision: "episode_component",
      finalCents: 0,
      selection: { membershipId: null, benefitId: null },
    });
    expect(ask("assessment-clinician-review", [], { episode }).decision).toBe("episode_component");
    expect(
      ask("comprehensive-blood-panel", [], { episode, deliveryMethod: "mobile_phlebotomy" })
    ).toMatchObject({ decision: "episode_component", finalCents: 12000 });
    // Claimed components and services outside the bundle are priced normally.
    expect(ask("dexa-scan", [], { episode }).decision).toBe("retail");
    expect(ask("clinician-telehealth-visit", [], { episode }).decision).toBe("retail");
    // Without the purchased marker a membership-less episode is ignored.
    expect(ask("vo2-max-test", [], { episode: { ...episode, purchased: false } }).decision).toBe(
      "retail"
    );
  });
  it("an unknown or inactive market makes every service unavailable; no market keeps all-market services", () => {
    const catalog = seedSnapshot();
    catalog.markets = catalog.markets.map((m) =>
      m.id === "las-vegas" ? { ...m, active: false } : m
    );
    const mobile = { deliveryMethod: "mobile_phlebotomy" };
    expect(ask("comprehensive-blood-panel", [], mobile, catalog).denialReason).toBe(
      "MARKET_UNAVAILABLE"
    );
    expect(ask("clinician-telehealth-visit", [], { marketId: "nowhere" }).denialReason).toBe(
      "MARKET_UNAVAILABLE"
    );
    expect(ask("clinician-telehealth-visit", [], { marketId: null }).finalCents).toBe(25000);
  });
  it("chooses the candidate with the lowest final amount including fees", () => {
    const catalog = withBenefit("everhaus-member", "advanced-assessment", {
      pricing: { mode: "custom", customPriceCents: 0 },
    });
    catalog.modifiers = catalog.modifiers.map((m) => ({ ...m, chargeWhenIncluded: false }));
    const q = ask(
      "advanced-assessment",
      [...ESSENTIAL, ...EVERHAUS],
      { deliveryMethod: "mobile_phlebotomy" },
      catalog
    );
    expect(q).toMatchObject({ decision: "allowance", finalCents: 0 });
  });
  it("explains denials by priority: exhausted > not purchasable > not eligible", () => {
    const exhausted = withBenefit("aerwell-essential", "assessment-clinician-review", {
      includedQuantity: 1,
      period: { unit: "year", anchor: "anniversary", rollover: "none" },
      exhaustion: "deny",
    });
    const usage = { "m-aerwell-essential:assessment-clinician-review": 1 };
    expect(ask("assessment-clinician-review", ESSENTIAL, { usage }, exhausted).denialReason).toBe(
      "ALLOWANCE_EXHAUSTED"
    );
    const ineligible = withBenefit("aerwell-essential", "assessment-clinician-review", {
      access: "ineligible",
    });
    expect(ask("assessment-clinician-review", ESSENTIAL, {}, ineligible).denialReason).toBe(
      "NOT_PURCHASABLE"
    );
  });
});
