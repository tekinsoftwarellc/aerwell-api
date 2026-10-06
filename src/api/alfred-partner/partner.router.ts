import { Router } from "express";
import { createScopedRateLimiter } from "../../common/middleware/rateLimiter.js";
import type { CacheService } from "../../common/services/cache.service.js";
import { env } from "../../config/env.js";
import {
  alfredServiceAuth,
  requireContractVersion,
  requireMemberAct,
  resolveActingMember,
} from "./partnerAuth.js";

/** Kill switch: unset means on everywhere except production, which must opt in. */
export const partnerContractEnabled = (): boolean =>
  env.PARTNER_CONTRACT_ENABLED
    ? env.PARTNER_CONTRACT_ENABLED === "true"
    : env.NODE_ENV !== "production";

const PRE_AUTH_PER_MINUTE = 3000;
const PER_SERVICE_PER_MINUTE = 600;

/**
 * Guard chain for one partner route, built per route because the prefix is shared with the staff
 * assistant. The global per-IP limiter exempts these paths (Alfred is one IP). A loose per-IP limit
 * runs first so bad tokens cannot flood the key fetch; the real limit is per service, after auth.
 */
export const partnerGuards = (cache: CacheService) => {
  const perIp = createScopedRateLimiter(cache, {
    prefix: "rl:alfred-ip:",
    windowSeconds: 60,
    max: PRE_AUTH_PER_MINUTE,
  });
  const perService = createScopedRateLimiter(cache, {
    prefix: "rl:alfred-svc:",
    windowSeconds: 60,
    max: PER_SERVICE_PER_MINUTE,
    keyFn: (req) => req.partner?.svc ?? "unknown",
  });
  const org = [perIp, alfredServiceAuth, requireContractVersion, perService] as const;
  return { org, member: [...org, requireMemberAct, resolveActingMember] as const };
};

/** Partner Contract v1, served at `/api/v1/alfred/*` (its own document, not in swagger). */
export const createPartnerRouter = (cache: CacheService): Router => {
  const router = Router();
  partnerGuards(cache);
  return router;
};
