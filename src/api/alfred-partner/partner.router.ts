import { Router } from "express";
import { empty } from "../../common/http.js";
import { createScopedRateLimiter } from "../../common/middleware/rateLimiter.js";
import { validate } from "../../common/middleware/validate.js";
import type { CacheService } from "../../common/services/cache.service.js";
import { asyncHandler } from "../../common/utils/asyncHandler.js";
import { env } from "../../config/env.js";
import { getCatalogItem, listCatalog } from "./partner.catalog.controller.js";
import { provisionMember } from "./partner.members.controller.js";
import {
  catalogItemParams,
  catalogItemQuery,
  catalogQuery,
  provisionBody,
} from "./partner.schema.js";
import {
  alfredServiceAuth,
  requireContractVersion,
  requireMemberAct,
  resolveActingMember,
} from "./partnerAuth.js";
import { idempotent } from "./partnerIdempotency.js";

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
  const guard = partnerGuards(cache);
  const nothing = { body: empty, query: empty, params: empty };

  // §5.1. The member does not exist yet, so only the delegation claim is required, not the member.
  router.post(
    "/members",
    ...guard.org,
    requireMemberAct,
    validate({ ...nothing, body: provisionBody }),
    idempotent(),
    asyncHandler(provisionMember)
  );
  // §5.3, §5.4: org-level pulls. `act` is ignored unless `accountId` is asked for.
  router.get(
    "/catalog",
    ...guard.org,
    validate({ ...nothing, query: catalogQuery }),
    asyncHandler(listCatalog)
  );
  router.get(
    "/catalog/:partnerRef",
    ...guard.org,
    validate({ ...nothing, params: catalogItemParams, query: catalogItemQuery }),
    asyncHandler(getCatalogItem)
  );
  return router;
};
