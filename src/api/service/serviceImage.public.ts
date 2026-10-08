import { Router } from "express";
import { z } from "zod";
import { NotFoundError } from "../../common/errors/AppError.js";
import { validate } from "../../common/middleware/validate.js";
import { asyncHandler } from "../../common/utils/asyncHandler.js";
import { env } from "../../config/env.js";
import { Service } from "./service.model.js";
import { slug } from "./service.schema.js";
import { serviceImageUrl } from "./serviceImage.service.js";

export const PUBLIC_SERVICE_IMAGE_PATH = "/api/v1/public/service-images";

/** Stable link to a service's marketing image, for Alfred's catalog and the member app. */
export const serviceImageLink = (service: { slug?: string | null; imageKey?: string | null }) =>
  env.PUBLIC_API_URL && service.slug && service.imageKey
    ? // `v` changes with every new image, so a cached copy never outlives a replacement.
      `${env.PUBLIC_API_URL.replace(/\/+$/, "")}${PUBLIC_SERVICE_IMAGE_PATH}/${service.slug}?v=${service.imageKey.split("/").at(-1)}`
    : undefined;

export const publicServiceImageRouter = Router();

/**
 * Unauthenticated: redirects to a fresh 300 s presigned GET of an active Aerwell service's image.
 * Slugs are unique per organization only, so the lookup is pinned to AERWELL_ORG_ID, the one
 * organization the partner catalog publishes. Serves service-image keys only, nothing else.
 */
publicServiceImageRouter.get(
  "/public/service-images/:slug",
  validate({
    params: z.object({ slug }).strict(),
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
    const service = organizationId
      ? await Service.findOne({
          organizationId,
          slug: String(req.params["slug"]),
          status: "active",
          deletedAt: null,
          imageKey: { $type: "string" },
        })
          .select("imageKey")
          .lean()
      : null;
    const key = service?.imageKey;
    if (!key?.startsWith(`${organizationId}/service-images/`))
      throw new NotFoundError("Image not found");
    res
      .set("Cache-Control", "public, max-age=240")
      .redirect(302, String(await serviceImageUrl(key)));
  })
);
