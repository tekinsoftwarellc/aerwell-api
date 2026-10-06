import type { Request, Response } from "express";
import type { z } from "zod";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../../common/errors/AppError.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { env } from "../../config/env.js";
import { Service } from "../service/service.model.js";
import { cancellationPolicyOf, loadCatalogContext, toCatalogItem } from "./catalogItem.js";
import type { catalogQuery } from "./partner.schema.js";
import { afterKeyset, decodeCursor, encodeCursor } from "./partnerCursor.js";

const orgOf = (): string => {
  if (!env.AERWELL_ORG_ID) throw new UnauthorizedError("Partner organization is not configured");
  return env.AERWELL_ORG_ID;
};

/** Published services: slugged, and never the Alfred-owned bundle (it has no listing). */
const published = (organizationId: string) => ({
  organizationId,
  slug: { $type: "string" },
  "bundleComponentIds.0": { $exists: false },
});

/** `GET /catalog` (§5.3): keyset pages on `(updatedAt, _id)`, inclusive `updatedSince`. */
export async function listCatalog(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as z.output<typeof catalogQuery>;
  // Personalising for a member the token does not name is the whole attack.
  if (query.accountId) {
    if (!req.partner?.accountId)
      throw new UnauthorizedError("Service token is missing the act claim");
    if (query.accountId !== req.partner.accountId)
      throw new BadRequestError("accountId must match the acting member");
  }
  if (query.kind && query.kind !== "services") {
    res.json(ServiceResponse.success("Catalogue", { items: [], nextCursor: null }));
    return;
  }
  const organizationId = orgOf();
  const filter: Record<string, unknown> = { ...published(organizationId) };
  // A full import lists active items only; an incremental pull also carries inactive and deleted.
  if (query.updatedSince) filter["updatedAt"] = { $gte: new Date(query.updatedSince) };
  else Object.assign(filter, { status: "active", deletedAt: null });
  const rows = await Service.find(
    query.cursor ? { $and: [filter, afterKeyset(decodeCursor(query.cursor))] } : filter
  )
    .sort({ updatedAt: 1, _id: 1 })
    .limit(query.limit + 1)
    .lean();
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const ctx = await loadCatalogContext(organizationId);
  res.json(
    ServiceResponse.success("Catalogue", {
      items: page.map((row) => toCatalogItem(row as never, ctx)),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor(last.updatedAt, String(last._id)) : null,
    })
  );
}

/** `GET /catalog/{partnerRef}` (§5.4): live detail by slug; unknown, deleted or inactive is 404. */
export async function getCatalogItem(req: Request, res: Response): Promise<void> {
  const organizationId = orgOf();
  const service = await Service.findOne({
    ...published(organizationId),
    slug: String(req.params["partnerRef"]),
    status: "active",
    deletedAt: null,
  }).lean();
  if (!service) throw new NotFoundError("Unknown catalogue item");
  const ctx = await loadCatalogContext(organizationId);
  res.json(
    ServiceResponse.success("Catalogue item", {
      ...toCatalogItem(service as never, ctx),
      cancellationPolicy: cancellationPolicyOf(service as never),
    })
  );
}
