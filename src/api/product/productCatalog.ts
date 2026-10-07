import { logger } from "../../common/utils/logger.js";
import { env } from "../../config/env.js";
import { enqueue } from "../alfred-partner/outbox/partnerOutbox.service.js";
import { partnerOutboxEnabled } from "../alfred-partner/partner.config.js";
import { SupplementProduct } from "../supplement/supplement.js";

/** A product's `partnerRef`. The prefix keeps it from ever colliding with a service slug. */
export const PRODUCT_REF_PREFIX = "prod_";
export const SKU_PATTERN = /^[a-z0-9][a-z0-9_-]{0,59}$/;
export const productRef = (sku: string) => `${PRODUCT_REF_PREFIX}${sku}`;
/** The SKU an `itemRef` names, or null when the ref is not a product's. */
export const skuOf = (itemRef: string): string | null =>
  itemRef.startsWith(PRODUCT_REF_PREFIX) ? itemRef.slice(PRODUCT_REF_PREFIX.length) : null;

export const PUBLIC_PRODUCT_IMAGE_PATH = "/api/v1/public/product-images";

type ProductFacts = {
  sku: string;
  name: string;
  description?: string | null;
  priceCents: number;
  active: boolean;
  forSale: boolean;
  imageKey?: string | null;
  updatedAt: Date;
};

/** Stable link to a product image for Alfred's catalog; `v` changes with every new image. */
export const productImageLink = (p: { sku: string; imageKey?: string | null }) =>
  env.PUBLIC_API_URL && p.imageKey
    ? `${env.PUBLIC_API_URL.replace(/\/+$/, "")}${PUBLIC_PRODUCT_IMAGE_PATH}/${p.sku}?v=${p.imageKey.split("/").at(-1)}`
    : undefined;

/** The catalogue item of contract §5.3 for one product. Stock is never published: the order decides. */
export function toProductItem(p: ProductFacts) {
  const image = productImageLink(p);
  return {
    partnerRef: productRef(p.sku),
    kind: "products" as const,
    title: p.name,
    description: p.description ?? "",
    media: image ? [{ url: image, kind: "image" as const }] : [],
    pricing: [
      { mode: "one_time" as const, amountCents: p.priceCents, currency: "usd", tierKeys: [] },
    ],
    locations: [] as string[],
    visibility: "all" as const,
    status: p.active && p.forSale ? ("active" as const) : ("inactive" as const),
    fulfilment: "standard" as const,
    tags: ["product"],
    // The pull sorts and watermarks on updatedAt, so it is also the item's monotonic version.
    version: p.updatedAt.getTime(),
  };
}

/** Tell Alfred a product changed. Best effort like `publishCatalogChange`: the pull is the safety net. */
export async function publishProductChange(organizationId: string, productId: unknown) {
  if (!partnerOutboxEnabled()) return;
  try {
    const row = await SupplementProduct.findOne({ _id: productId, organizationId }).lean();
    if (!row) return;
    const ref = productRef(row.sku);
    await enqueue({
      type: "catalog.upserted",
      occurredAt: row.updatedAt,
      resource: { kind: "catalog_item", ref },
      payload: toProductItem(row) as unknown as Record<string, unknown>,
    });
  } catch (error) {
    logger.error({ errorType: (error as Error).name }, "product catalog event could not be queued");
  }
}
