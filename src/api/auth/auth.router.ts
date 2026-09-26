import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../common/middleware/authenticate.js";
import { createScopedRateLimiter } from "../../common/middleware/rateLimiter.js";
import { validate } from "../../common/middleware/validate.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import type { CacheService } from "../../common/services/cache.service.js";
import { asyncHandler } from "../../common/utils/asyncHandler.js";
import { unreadCount } from "../notification/notification.router.js";
import { MODULES } from "../role/permission.js";
import {
  changeSchema,
  forgotSchema,
  loginSchema,
  otpSchema,
  refreshSchema,
  resetSchema,
} from "./auth.schema.js";
import {
  changePassword,
  forgotPassword,
  loginStaff,
  resetPassword,
  verifyOtp,
} from "./auth.service.js";
import { getMe } from "./me.service.js";
import { logoutSession, refreshSession } from "./session.service.js";
export function createAuthRouter(cache: CacheService) {
  const router = Router();
  const limit = (name: string, max: number, windowSeconds = 60) =>
    createScopedRateLimiter(cache, { prefix: `auth:${name}:`, max, windowSeconds });
  router.post(
    "/login",
    limit("login", 10),
    validate(loginSchema),
    asyncHandler(async (req, res) => {
      res.json(ServiceResponse.success("OK", await loginStaff(req.body.email, req.body.password)));
    })
  );
  router.post(
    "/refresh",
    limit("refresh", 30),
    validate(refreshSchema),
    asyncHandler(async (req, res) => {
      res.json(ServiceResponse.success("OK", await refreshSession(req.body.refreshToken)));
    })
  );
  router.post(
    "/logout",
    limit("logout", 30),
    validate(refreshSchema),
    asyncHandler(async (req, res) => {
      await logoutSession(req.body.refreshToken);
      res.json(ServiceResponse.success("Signed out", null));
    })
  );
  router.post(
    "/2fa/verify",
    limit("otp", 20),
    validate(otpSchema),
    asyncHandler(async (req, res) => {
      res.json(ServiceResponse.success("OK", await verifyOtp(req.body.challengeId, req.body.code)));
    })
  );
  router.post(
    "/forgot-password",
    limit("recovery", 3, 3600),
    validate(forgotSchema),
    asyncHandler(async (req, res) => {
      await forgotPassword(req.body.email);
      res
        .status(202)
        .json(
          ServiceResponse.success(
            "If an eligible account exists, a reset link will be sent. Contact your admin if it does not arrive.",
            null,
            202
          )
        );
    })
  );
  router.post(
    "/reset-password",
    limit("reset", 5, 900),
    validate(resetSchema),
    asyncHandler(async (req, res) => {
      await resetPassword(req.body.token, req.body.password);
      res.json(ServiceResponse.success("Password reset. Sign in to continue.", null));
    })
  );
  router.post(
    "/change-password",
    authenticate,
    limit("change", 5, 900),
    validate(changeSchema),
    asyncHandler(async (req, res) => {
      if (!req.staff) return;
      await changePassword(req.staff, req.body.currentPassword, req.body.password);
      res.json(ServiceResponse.success("Password changed. Sign in again.", null));
    })
  );
  return router;
}
export const meRouter = Router();
meRouter.get(
  "/me",
  authenticate,
  validate({ query: z.object({}).strict() }),
  asyncHandler(async (req, res) => {
    if (req.staff) res.json(ServiceResponse.success("OK", await getMe(req.staff)));
  })
);
meRouter.get(
  "/me/counters",
  authenticate,
  validate({ query: z.object({}).strict() }),
  asyncHandler(async (req, res) => {
    res.json(ServiceResponse.success("OK", { unreadNotifications: await unreadCount(req) }));
  })
);
meRouter.get(
  "/permissions/modules",
  authenticate,
  validate({ query: z.object({}).strict() }),
  (_req, res) => {
    res.json(
      ServiceResponse.success(
        "OK",
        MODULES.map((id) => ({ id, label: id.toLowerCase().replaceAll("_", " ") }))
      )
    );
  }
);
