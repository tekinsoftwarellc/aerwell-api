import type { Request, Response } from "express";
import type { z } from "zod";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../../common/errors/AppError.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { env } from "../../config/env.js";
import { Member } from "../member/member.model.js";
import { PRODUCT_REF_PREFIX, skuOf, toProductItem } from "../product/productCatalog.js";
import { Service } from "../service/service.model.js";
import { SupplementOrder, SupplementProduct } from "../supplement/supplement.js";
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

const byKeyset = (a: { updatedAt: Date; _id: unknown }, b: { updatedAt: Date; _id: unknown }) =>
  a.updatedAt.getTime() - b.updatedAt.getTime() || String(a._id).localeCompare(String(b._id));

/**
 * Products as a member may see them. Given an `accountId` only the products a clinician prescribed
 * to that member are returned (§5.3); an unknown member sees none.
 */
async function productFilter(organizationId: string, accountId: string | undefined) {
  if (!accountId) return {};
  const member = await Member.findOne({ organizationId, alfredAccountId: accountId })
    .select("_id")
    .lean();
  const ids = member
    ? await SupplementOrder.distinct("productId", { organizationId, memberId: member._id })
    : [];
  return { _id: { $in: ids } };
}

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
  const organizationId = orgOf();
  const since = query.updatedSince ? { updatedAt: { $gte: new Date(query.updatedSince) } } : {};
  const after = query.cursor ? afterKeyset(decodeCursor(query.cursor)) : null;
  const pageOf = (f: object) => (after ? { $and: [f, after] } : f);
  // A full import lists active items only; an incremental pull also carries inactive and deleted.
  const services =
    query.kind && query.kind !== "services"
      ? []
      : await Service.find(
          pageOf({
            ...published(organizationId),
            ...(query.updatedSince ? since : { status: "active", deletedAt: null }),
          })
        )
          .sort({ updatedAt: 1, _id: 1 })
          .limit(query.limit + 1)
          .lean();
  const products =
    query.kind && query.kind !== "products"
      ? []
      : await SupplementProduct.find(
          pageOf({
            organizationId,
            // A prescription does not touch the product row, so a member's pull cannot use the watermark:
            // it returns every product prescribed to that member (Alfred ignores versions it already holds).
            ...(query.accountId ? {} : query.updatedSince ? since : { active: true, forSale: true }),
            ...(await productFilter(organizationId, query.accountId)),
          })
        )
          .sort({ updatedAt: 1, _id: 1 })
          .limit(query.limit + 1)
          .lean();
  const merged = [
    ...services.map((row) => ({
      updatedAt: row.updatedAt,
      _id: row._id,
      kind: "service" as const,
      row,
    })),
    ...products.map((row) => ({
      updatedAt: row.updatedAt,
      _id: row._id,
      kind: "product" as const,
      row,
    })),
  ].sort(byKeyset);
  const page = merged.slice(0, query.limit);
  const last = page.at(-1);
  const ctx = await loadCatalogContext(organizationId);
  res.json(
    ServiceResponse.success("Catalogue", {
      items: page.map((r) =>
        r.kind === "service" ? toCatalogItem(r.row as never, ctx) : toProductItem(r.row as never)
      ),
      nextCursor:
        merged.length > query.limit && last ? encodeCursor(last.updatedAt, String(last._id)) : null,
    })
  );
}

/** `GET /catalog/{partnerRef}` (§5.4): live detail by slug; unknown, deleted or inactive is 404. */
export async function getCatalogItem(req: Request, res: Response): Promise<void> {
  const organizationId = orgOf();
  const ref = String(req.params["partnerRef"]);
  if (ref.startsWith(PRODUCT_REF_PREFIX)) {
    const product = await SupplementProduct.findOne({
      organizationId,
      sku: skuOf(ref),
      active: true,
      forSale: true,
    }).lean();
    if (!product) throw new NotFoundError("Unknown catalogue item");
    res.json(ServiceResponse.success("Catalogue item", toProductItem(product)));
    return;
  }
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
