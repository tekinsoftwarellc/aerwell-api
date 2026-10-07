import { z } from "zod";
import { objectId } from "../../common/http.js";
import { SKU_PATTERN } from "./productCatalog.js";

const text = (max: number) => z.string().trim().max(max);
const fields = {
  name: text(200).min(1),
  brand: text(120).nullable(),
  size: text(120).nullable(),
  description: text(4000),
  priceCents: z.number().int().min(0).max(10_000_000),
  stock: z.number().int().min(0).max(1_000_000),
  weightGrams: z.number().int().min(0).max(1_000_000).nullable(),
  forSale: z.boolean(),
  active: z.boolean(),
  /** An id from `POST /services/images/presign` after the browser uploaded the file. */
  imageUploadId: objectId,
};
export const productCreate = z
  .object({
    sku: z.string().regex(SKU_PATTERN, "Lowercase letters, digits, - and _"),
    name: fields.name,
    brand: fields.brand.optional(),
    size: fields.size.optional(),
    description: fields.description.default(""),
    priceCents: fields.priceCents,
    stock: fields.stock.default(0),
    weightGrams: fields.weightGrams.optional(),
    forSale: fields.forSale.default(false),
    imageUploadId: fields.imageUploadId.optional(),
  })
  .strict();
export const productPatch = z
  .object({
    name: fields.name,
    brand: fields.brand,
    size: fields.size,
    description: fields.description,
    priceCents: fields.priceCents,
    stock: fields.stock,
    weightGrams: fields.weightGrams,
    forSale: fields.forSale,
    active: fields.active,
    imageUploadId: fields.imageUploadId,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field");

export const orderList = z
  .object({
    status: z.enum(["placed", "paid", "shipped", "delivered", "cancelled", "refunded"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export const shipBody = z
  .object({
    carrier: text(60).min(1),
    number: text(100).min(1),
    url: z.string().url().max(500).optional(),
  })
  .strict();
