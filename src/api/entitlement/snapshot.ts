// DB -> plain CatalogSnapshot for the pure evaluator. Read-only.
import { DeliveryModifier, Market, MembershipPlan } from "../catalog/catalog.model.js";
import { Service } from "../service/service.model.js";
import type {
  BenefitConfig,
  CatalogSnapshot,
  DeliveryModifierConfig,
  PlanConfig,
  ServiceConfig,
} from "./entitlement.types.js";

const ids = (values: unknown[]) => values.map(String);
// `version` is the mongoose versionKey, so it is absent from the inferred type.
const versionOf = (doc: object) => (doc as { version?: number }).version ?? 0;

export async function loadCatalogSnapshot(organizationId: string): Promise<CatalogSnapshot> {
  const [services, markets, plans, modifiers] = await Promise.all([
    Service.find({ organizationId }).lean(),
    Market.find({ organizationId }).lean(),
    // Legacy Tier 1/2/3 documents have no slug and are never evaluated.
    MembershipPlan.find({ organizationId, slug: { $type: "string" } }).lean(),
    DeliveryModifier.find({ organizationId }).lean(),
  ]);
  return {
    services: services.map(
      (s): ServiceConfig => ({
        id: String(s._id),
        version: versionOf(s),
        owner: s.owner ?? "aerwell",
        status: s.deletedAt ? "archived" : (s.status ?? "inactive"),
        retailCents: s.basePriceCents ?? null,
        marketScope: s.marketScope ?? "listed",
        marketIds: ids(s.marketIds ?? []),
        bundleComponentIds: ids(s.bundleComponentIds ?? []),
      })
    ),
    markets: markets.map((m) => ({ id: String(m._id), active: m.active ?? false })),
    plans: plans.map(
      (p): PlanConfig => ({
        id: String(p._id),
        version: versionOf(p),
        status: p.status ?? "archived",
        isBaseline: p.isBaseline ?? false,
        clinicianChat: p.clinicianChat ?? false,
        restrictedOwners: p.restrictedOwners ?? [],
        benefits: (p.benefits ?? []).map(
          (b): BenefitConfig => ({
            id: b.id,
            serviceId: String(b.serviceId),
            access: b.access,
            includedQuantity: b.includedQuantity ?? 0,
            period: b.period
              ? { unit: b.period.unit, anchor: "anniversary", rollover: "none" }
              : null,
            exhaustion: b.exhaustion ?? "paid",
            pricing: {
              mode: b.pricing.mode,
              ...(b.pricing.discountBps == null ? {} : { discountBps: b.pricing.discountBps }),
              ...(b.pricing.customPriceCents == null
                ? {}
                : { customPriceCents: b.pricing.customPriceCents }),
            },
          })
        ),
      })
    ),
    modifiers: modifiers.map(
      (m): DeliveryModifierConfig => ({
        id: String(m._id),
        key: m.slug,
        version: versionOf(m),
        active: m.active ?? false,
        amountCents: m.amountCents,
        serviceIds: ids(m.serviceIds ?? []),
        marketScope: m.marketScope ?? "all",
        marketIds: ids(m.marketIds ?? []),
        chargeWhenIncluded: m.chargeWhenIncluded ?? true,
      })
    ),
  };
}
