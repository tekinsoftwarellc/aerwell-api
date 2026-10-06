import { logger } from "../../../common/utils/logger.js";
import { Service } from "../../service/service.model.js";
import { loadCatalogContext, toCatalogItem } from "../catalogItem.js";
import { partnerOutboxEnabled } from "../partner.config.js";
import { enqueue } from "./partnerOutbox.service.js";

/**
 * Tell Alfred a service changed (`catalog.upserted`) or went away (`catalog.removed`). The pull is
 * the safety net, so this is best effort and never throws: the edit it follows has already committed.
 * Only while the outbox is on: before that nobody is listening and rows would pile up. The Alfred-owned bundle
 * has no listing and is never announced.
 */
export async function publishCatalogChange(organizationId: string, serviceIds: unknown[]) {
  if (!partnerOutboxEnabled() || serviceIds.length === 0) return;
  try {
    const [services, ctx] = await Promise.all([
      Service.find({
        organizationId,
        _id: { $in: serviceIds },
        slug: { $type: "string" },
        "bundleComponentIds.0": { $exists: false },
      }).lean(),
      loadCatalogContext(organizationId),
    ]);
    for (const service of services) {
      const slug = service.slug ?? "";
      const resource = { kind: "catalog_item", ref: slug };
      if (service.deletedAt)
        await enqueue({
          type: "catalog.removed",
          occurredAt: service.updatedAt,
          resource,
          payload: { partnerRef: slug },
        });
      else
        await enqueue({
          type: "catalog.upserted",
          occurredAt: service.updatedAt,
          resource,
          payload: toCatalogItem(service as never, ctx) as unknown as Record<string, unknown>,
        });
    }
  } catch (error) {
    logger.error({ errorType: (error as Error).name }, "catalog event could not be queued");
  }
}
