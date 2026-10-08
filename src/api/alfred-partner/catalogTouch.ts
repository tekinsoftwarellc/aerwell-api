import { logger } from "../../common/utils/logger.js";
import { Service } from "../service/service.model.js";
import { publishCatalogChange } from "./outbox/catalogEvents.js";

/**
 * A catalog item's `version` is `Service.updatedAt` and nothing else: the pull sorts and
 * watermarks on that one field. A market edit changes where services are offered without
 * touching the service rows, so it bumps them here or the incremental pull would never see it.
 * Never throws: the market is already saved, and a missed bump heals on the next edit or full import.
 */
export async function touchServicesOfMarket(organizationId: string, marketId: unknown) {
  try {
    const affected = { organizationId, $or: [{ marketScope: "all" }, { marketIds: marketId }] };
    await Service.updateMany(affected, { $set: { updatedAt: new Date() } }, { timestamps: false });
    await publishCatalogChange(organizationId, await Service.find(affected).distinct("_id"));
  } catch (error) {
    logger.error({ errorType: (error as Error).name }, "catalog version touch failed");
  }
}
