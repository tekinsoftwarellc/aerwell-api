import { Market } from "../catalog/catalog.model.js";
import { Location } from "../location/location.model.js";
import { Service } from "../service/service.model.js";

type ServiceRow = InstanceType<typeof Service>;
type ServiceFacts = Pick<
  ServiceRow,
  | "slug"
  | "title"
  | "description"
  | "status"
  | "deletedAt"
  | "modality"
  | "marketScope"
  | "marketIds"
  | "locationId"
  | "durationMinutes"
  | "capacityMax"
  | "basePriceCents"
  | "updatedAt"
> & { _id: unknown; lateCancellationFee?: ServiceRow["lateCancellationFee"] | null };

export interface CatalogItem {
  partnerRef: string;
  kind: "services";
  title: string;
  description: string;
  media: { url: string; kind: "image" }[];
  pricing: { mode: "one_time"; amountCents: number; currency: "usd"; tierKeys: string[] }[];
  locations: string[];
  visibility: "all";
  status: "active" | "inactive" | "deleted";
  fulfilment: "standard";
  durationMin: number;
  capacity: number;
  tags: string[];
  version: number;
}

/** What the mapper needs beyond the service row: where it is offered, and which services are bundle parts. */
export interface CatalogContext {
  allLocationIds: string[];
  marketLocations: Map<string, string[]>;
  componentIds: Set<string>;
}

export async function loadCatalogContext(organizationId: string): Promise<CatalogContext> {
  const [locations, markets, bundles] = await Promise.all([
    Location.find({ organizationId }).select("_id").lean(),
    Market.find({ organizationId, active: true }).select("locationIds").lean(),
    Service.find({ organizationId, "bundleComponentIds.0": { $exists: true } })
      .select("bundleComponentIds")
      .lean(),
  ]);
  return {
    allLocationIds: locations.map((l) => String(l._id)),
    marketLocations: new Map(markets.map((m) => [String(m._id), m.locationIds.map(String)])),
    componentIds: new Set(bundles.flatMap((b) => b.bundleComponentIds.map(String))),
  };
}

/**
 * Where a service is offered. Virtual services are not location-bound (empty). A listed service
 * is offered only in its markets' locations (this is what carries "DEXA is Las Vegas only"), and a
 * service pinned to one location only there.
 */
export function offeredLocations(service: ServiceFacts, ctx: CatalogContext): string[] {
  if (service.modality === "virtual") return [];
  const base =
    service.marketScope === "all"
      ? ctx.allLocationIds
      : [...new Set(service.marketIds.flatMap((id) => ctx.marketLocations.get(String(id)) ?? []))];
  return service.locationId ? base.filter((id) => id === String(service.locationId)) : base;
}

/** Display policy for one service. The authoritative answer is the cancellation quote. */
export function cancellationPolicyOf(service: ServiceFacts) {
  const policy = service.lateCancellationFee;
  const windowHours = policy?.windowHours ?? 24;
  const fee = policy?.enabled ? policy.amountCents : undefined;
  return {
    summary: `Cancel at least ${windowHours} hours ahead to keep your visit unit. Later cancellations use the unit.`,
    windowHours,
    ...(fee ? { lateFeeCents: fee } : {}),
  };
}

/** Labels Alfred searches by: modality, `lab` for anything done in person, and bundle parts. */
export const tagsFor = (modality: string | null | undefined, component: boolean): string[] => [
  modality === "virtual" ? "virtual" : "physical",
  ...(modality === "virtual" ? [] : ["lab"]),
  ...(component ? ["assessment_component"] : []),
];

export function toCatalogItem(service: ServiceFacts, ctx: CatalogContext): CatalogItem {
  const locations = offeredLocations(service, ctx);
  const virtual = service.modality === "virtual";
  const status = service.deletedAt
    ? "deleted"
    : // A physical service offered nowhere must not read as "not location-bound" to Alfred.
      service.status !== "active" || (!virtual && locations.length === 0)
      ? "inactive"
      : "active";
  return {
    partnerRef: service.slug ?? "",
    kind: "services",
    title: service.title,
    description: service.description ?? "",
    media: [],
    pricing:
      service.basePriceCents == null
        ? []
        : [
            {
              mode: "one_time",
              amountCents: service.basePriceCents,
              currency: "usd",
              tierKeys: [],
            },
          ],
    locations,
    visibility: "all",
    status,
    fulfilment: "standard",
    durationMin: service.durationMinutes,
    capacity: service.capacityMax ?? 1,
    tags: tagsFor(service.modality, ctx.componentIds.has(String(service._id))),
    // The pull sorts and watermarks on updatedAt, so it is also the item's monotonic version.
    version: service.updatedAt.getTime(),
  };
}
