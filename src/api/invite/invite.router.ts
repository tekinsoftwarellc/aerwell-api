import { Router } from "express";
import { z } from "zod";
import { actor, idParams, objectId, secured } from "../../common/http.js";
import { createScopedRateLimiter } from "../../common/middleware/rateLimiter.js";
import { validate } from "../../common/middleware/validate.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import type { CacheService } from "../../common/services/cache.service.js";
import { asyncHandler } from "../../common/utils/asyncHandler.js";
import { emailSchema, passwordSchema } from "../auth/auth.schema.js";
import { Invite } from "./invite.model.js";
import { acceptInvite, changeInvite, createInvite } from "./invite.service.js";
export function createInviteRouter(cache: CacheService) {
  const router = Router();
  const master = { module: "STAFF_RECORDS", level: "master" } as const;
  const query = z
    .object({ status: z.enum(["pending", "accepted", "revoked", "expired"]).optional() })
    .strict();
  secured(
    router,
    "get",
    "/invites",
    { module: "STAFF_RECORDS", level: "view" },
    { query },
    async (req) => {
      const status = req.query["status"];
      const filter = {
        organizationId: actor(req).organizationId,
        ...(status ? { status: status === "expired" ? "pending" : status } : {}),
        ...(status === "pending"
          ? { expiresAt: { $gt: new Date() } }
          : status === "expired"
            ? { expiresAt: { $lte: new Date() } }
            : {}),
      };
      return await Invite.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    }
  );
  secured(
    router,
    "post",
    "/invites",
    master,
    { body: z.object({ email: emailSchema, roleId: objectId }).strict() },
    createInvite,
    201
  );
  secured(router, "post", "/invites/:id/resend", master, { params: idParams }, (req) =>
    changeInvite(req)
  );
  secured(router, "post", "/invites/:id/revoke", master, { params: idParams }, (req) =>
    changeInvite(req, true)
  );
  router.post(
    "/auth/accept-invite",
    createScopedRateLimiter(cache, { prefix: "auth:invite:", max: 5, windowSeconds: 900 }),
    validate(
      z
        .object({
          token: z.string().min(1).max(200),
          password: passwordSchema,
          firstName: z.string().trim().min(1).max(100),
          lastName: z.string().trim().min(1).max(100),
        })
        .strict()
    ),
    asyncHandler(async (req, res) => {
      res.json(
        ServiceResponse.success(
          "Your staff account is ready. Sign in to continue.",
          await acceptInvite(req.body)
        )
      );
    })
  );
  return router;
}
