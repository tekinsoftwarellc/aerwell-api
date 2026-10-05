// Idempotent client catalog seed: $setOnInsert only, so re-running never
// overwrites a value staff have since edited. Local/memory databases only.
import { Service, ServiceCategory } from "../service/service.model.js";
import { CatalogRevision, DeliveryModifier, Market, MembershipPlan } from "./catalog.model.js";
import { seedMarkets, seedModifiers, seedPlans, seedServices } from "./catalog.seed-data.js";

type IdMap = Map<string, unknown>;
const upsert = { upsert: true, new: true } as const;
type Seeded = { _id: unknown; organizationId: string; toObject: () => Record<string, unknown> };
// History starts at the seeded version so every later edit has a predecessor.
async function recordSeed(entityType: string, doc: Seeded) {
  const entityId = String(doc._id);
  if (await CatalogRevision.exists({ organizationId: doc.organizationId, entityType, entityId }))
    return;
  const { __v, ...snapshot } = doc.toObject();
  await CatalogRevision.create({
    organizationId: doc.organizationId,
    entityType,
    entityId,
    version: Number(snapshot["version"] ?? 0),
    snapshot,
    actorId: "system:seed",
    effectiveFrom: new Date(),
  });
}
const resolve = (map: IdMap, keys: string[]) =>
  keys.map((key) => {
    const id = map.get(key);
    if (!id) throw new Error(`Seed reference missing: ${key}`);
    return id;
  });

async function seedMarketDocs(organizationId: string): Promise<IdMap> {
  const map: IdMap = new Map();
  for (const { key, ...market } of seedMarkets) {
    const doc = await Market.findOneAndUpdate(
      { organizationId, slug: key },
      { $setOnInsert: { organizationId, slug: key, ...market, version: 0 } },
      upsert
    );
    await recordSeed("market", doc);
    map.set(key, doc._id);
  }
  return map;
}

async function seedServiceDocs(organizationId: string, markets: IdMap): Promise<IdMap> {
  const categories = new Map(
    (await ServiceCategory.find({ organizationId })).map((c) => [c.name, c._id])
  );
  const map: IdMap = new Map();
  // Components first, so bundles can reference them.
  const ordered = [...seedServices].sort((a, b) => a.bundle.length - b.bundle.length);
  for (const s of ordered) {
    const doc = await Service.findOneAndUpdate(
      { organizationId, slug: s.slug },
      {
        $setOnInsert: {
          organizationId,
          slug: s.slug,
          title: s.title,
          description: s.description,
          categoryId: resolve(categories, [s.category])[0],
          basePriceCents: s.retailCents,
          modality: s.modality,
          marketScope: s.marketScope,
          marketIds: resolve(markets, s.marketKeys),
          bundleComponentIds: resolve(map, s.bundle),
          status: "active",
          // Operational placeholders: the client supplied no durations/capacity.
          durationMinutes: 60,
          capacityMin: 1,
          capacityMax: 1,
          version: 0,
        },
      },
      upsert
    );
    await recordSeed("service", doc);
    map.set(s.slug, doc._id);
  }
  return map;
}

async function seedPlanDocs(organizationId: string, services: IdMap) {
  for (const { benefits, ...plan } of seedPlans) {
    const doc = await MembershipPlan.findOneAndUpdate(
      { organizationId, slug: plan.slug },
      {
        $setOnInsert: {
          organizationId,
          ...plan,
          status: "active",
          version: 0,
          benefits: benefits.map((b) => {
            const serviceId = resolve(services, [b.service])[0];
            return {
              id: String(serviceId),
              serviceId,
              access: b.access,
              includedQuantity: b.includedQuantity,
              period: b.periodUnit
                ? { unit: b.periodUnit, anchor: "anniversary", rollover: "none" }
                : null,
              exhaustion: b.exhaustion,
              pricing: b.pricing,
            };
          }),
        },
      },
      upsert
    );
    await recordSeed("membership_plan", doc);
  }
}

export async function seedClientCatalog(organizationId: string): Promise<void> {
  const markets = await seedMarketDocs(organizationId);
  const services = await seedServiceDocs(organizationId, markets);
  await seedPlanDocs(organizationId, services);
  for (const { key, serviceSlugs, marketKeys, ...modifier } of seedModifiers) {
    const doc = await DeliveryModifier.findOneAndUpdate(
      { organizationId, slug: key },
      {
        $setOnInsert: {
          organizationId,
          slug: key,
          ...modifier,
          serviceIds: resolve(services, serviceSlugs),
          marketIds: resolve(markets, marketKeys),
          version: 0,
        },
      },
      upsert
    );
    await recordSeed("delivery_modifier", doc);
  }
}
