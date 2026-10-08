import { Router } from "express";
import { z } from "zod";
import { NotFoundError } from "../../common/errors/AppError.js";
import { validate } from "../../common/middleware/validate.js";
import { asyncHandler } from "../../common/utils/asyncHandler.js";
import { env } from "../../config/env.js";
import { serviceImageUrl } from "../service/serviceImage.service.js";
import { SupplementProduct } from "../supplement/supplement.js";
import { SKU_PATTERN } from "./productCatalog.js";

export const publicProductImageRouter = Router();

/**
 * Unauthenticated: redirects to a fresh 300 s presigned GET of a sellable product's image. Pinned to
 * AERWELL_ORG_ID (SKUs are unique per organization only) and to keys under its image prefix.
 */
publicProductImageRouter.get(
  "/public/product-images/:sku",
  validate({
    params: z.object({ sku: z.string().regex(SKU_PATTERN) }).strict(),
    query: z
      .object({
        v: z
          .string()
          .regex(/^[\w-]{1,64}$/)
          .optional(),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const organizationId = env.AERWELL_ORG_ID;
    const product = organizationId
      ? await SupplementProduct.findOne({
          organizationId,
          sku: String(req.params["sku"]),
          active: true,
          forSale: true,
          imageKey: { $type: "string" },
        })
          .select("imageKey")
          .lean()
      : null;
    const key = product?.imageKey;
    if (!key?.startsWith(`${organizationId}/service-images/`))
      throw new NotFoundError("Image not found");
    res
      .set("Cache-Control", "public, max-age=240")
      .redirect(302, String(await serviceImageUrl(key)));
  })
);
