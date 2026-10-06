import { Router } from "express";
import { empty } from "../../common/http.js";
import { createScopedRateLimiter } from "../../common/middleware/rateLimiter.js";
import { validate } from "../../common/middleware/validate.js";
import type { CacheService } from "../../common/services/cache.service.js";
import { asyncHandler } from "../../common/utils/asyncHandler.js";
import { env } from "../../config/env.js";
import { getAvailability } from "./partner.availability.controller.js";
import {
  cancelBooking,
  checkInBooking,
  createBooking,
  getBooking,
  getCancellationQuote,
  rescheduleBooking,
} from "./partner.bookings.controller.js";
import { getCatalogItem, listCatalog } from "./partner.catalog.controller.js";
import { receiveEvent } from "./partner.events.controller.js";
import { provisionMember } from "./partner.members.controller.js";
import { listOrders } from "./partner.orders.controller.js";
import {
  anyBody,
  availabilityQuery,
  bookingBody,
  bookingParams,
  cancelBody,
  catalogItemParams,
  catalogItemQuery,
  catalogQuery,
  eventBody,
  ordersQuery,
  provisionBody,
  rescheduleBody,
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
    idempotent(),
    validate({ ...nothing, body: provisionBody }),
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
  // §5.5. The member may not exist yet (Alfred provisions at the first order), and Aerwell applies no
  // member-specific rule to slots, so only the delegation claim is required.
  router.get(
    "/availability",
    ...guard.org,
    requireMemberAct,
    validate({ ...nothing, query: availabilityQuery }),
    asyncHandler(getAvailability)
  );

  // §5.7: every booking route acts for a member who must already exist. Writes claim their
  // Idempotency-Key before validation, so a rejected body is stored and replayed like any answer.
  const own = { ...nothing, params: bookingParams };
  router.post(
    "/bookings",
    ...guard.member,
    idempotent(),
    validate({ ...nothing, body: bookingBody }),
    asyncHandler(createBooking)
  );
  router.get("/bookings/:bookingRef", ...guard.member, validate(own), asyncHandler(getBooking));
  router.post(
    "/bookings/:bookingRef/reschedule",
    ...guard.member,
    idempotent(),
    validate({ ...own, body: rescheduleBody }),
    asyncHandler(rescheduleBooking)
  );
  router.get(
    "/bookings/:bookingRef/cancellation-quote",
    ...guard.member,
    validate(own),
    asyncHandler(getCancellationQuote)
  );
  router.post(
    "/bookings/:bookingRef/cancel",
    ...guard.member,
    idempotent(),
    validate({ ...own, body: cancelBody }),
    asyncHandler(cancelBooking)
  );
  router.post(
    "/bookings/:bookingRef/check-in",
    ...guard.member,
    idempotent(),
    validate({ ...own, body: anyBody }),
    asyncHandler(checkInBooking)
  );
  // §5.10: the orders sync stream. `act` is ignored unless `accountId` is asked for.
  router.get(
    "/orders",
    ...guard.org,
    validate({ ...nothing, query: ordersQuery }),
    asyncHandler(listOrders)
  );
  // §5.13: org level. Deduped on the body's own key, so no `idempotent()`.
  router.post(
    "/events",
    ...guard.org,
    validate({ ...nothing, body: eventBody }),
    asyncHandler(receiveEvent)
  );
  return router;
};
