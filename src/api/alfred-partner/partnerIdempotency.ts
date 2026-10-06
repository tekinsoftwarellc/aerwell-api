import { createHash } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { AppError, BadRequestError } from "../../common/errors/AppError.js";
import { asyncHandler } from "../../common/utils/asyncHandler.js";
import { logger } from "../../common/utils/logger.js";
import { env } from "../../config/env.js";
import { contractUnprocessable } from "./partner.errors.js";
import { PartnerIdempotencyKey } from "./partnerIdempotency.model.js";

/** Alfred's key is `action:accountId:listingId:slotRef:clientKey`, so colons are legal (not a uuid). */
const KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;
/** A claim older than this belongs to a process that died; the next replay may take it over. */
export const STALE_CLAIM_MS = 60_000;

/** Sort object keys recursively so key order and whitespace do not change the hash (§4.6). */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((k) => [k, canonical(source[k])])
    );
  }
  return value;
};
const hashBody = (body: unknown): string =>
  createHash("sha256")
    .update(body === undefined ? "" : JSON.stringify(canonical(body)))
    .digest("hex");

const isDuplicate = (error: unknown) => (error as { code?: number }).code === 11000;

/** Store the outcome. A 5xx releases the claim: the outcome is unknown, so a retry re-runs. */
async function persist(res: Response, claim: Record<string, string>, body: unknown) {
  try {
    if (res.statusCode >= 500) await PartnerIdempotencyKey.deleteOne(claim);
    else
      await PartnerIdempotencyKey.updateOne(claim, {
        $set: { state: "done", statusCode: res.statusCode, responseBody: body },
      });
  } catch (error) {
    // The row stays `pending` and heals after STALE_CLAIM_MS; a replay then re-runs the handler,
    // which is itself idempotent by key (booking) or by state (cancel, check-in).
    logger.warn({ errorType: (error as Error).name }, "idempotency store write failed");
  }
}

/** The answer goes out only after the outcome is stored, so a fast replay cannot beat the row. */
function storeThenSend(res: Response, claim: Record<string, string>) {
  const send = res.json.bind(res);
  res.json = ((body: unknown) => {
    persist(res, claim, body).finally(() => send(body));
    return res;
  }) as typeof res.json;
}

/**
 * `Idempotency-Key` for every Alfred POST (§4.6). Scope `(route pattern, key)`, 24 h, 4xx stored,
 * a different body is 422. Unlike a lookup-then-write store, the key is claimed up front, so two
 * identical requests in flight run the handler once; the loser gets 503 (outcome unknown), never a
 * 4xx, because Alfred refunds and releases the unit on a 4xx.
 */
export const idempotent = (): RequestHandler =>
  asyncHandler(async (req: Request, res: Response, next) => {
    const key = req.get("Idempotency-Key");
    if (!(key && KEY_PATTERN.test(key)))
      throw new BadRequestError("Idempotency-Key header is required");
    const organizationId = env.AERWELL_ORG_ID;
    if (!organizationId) throw new AppError("Partner organization is not configured", 503);
    const path = `${req.baseUrl}${req.route?.path ?? req.path}`;
    const claim = { organizationId, path, key };
    const bodyHash = hashBody(req.body);
    try {
      await PartnerIdempotencyKey.create({ ...claim, method: req.method, bodyHash });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const existing = await PartnerIdempotencyKey.findOne(claim).lean();
      if (!existing) throw new AppError("Request is being processed", 503);
      if (existing.bodyHash !== bodyHash)
        throw contractUnprocessable(
          "IDEMPOTENCY_MISMATCH",
          "Idempotency-Key reused with a different body"
        );
      if (existing.state === "done") {
        res.setHeader("Idempotency-Replayed", "true");
        res.status(existing.statusCode ?? 200).json(existing.responseBody);
        return;
      }
      const takeover = await PartnerIdempotencyKey.findOneAndUpdate(
        { ...claim, state: "pending", claimedAt: { $lt: new Date(Date.now() - STALE_CLAIM_MS) } },
        { $set: { claimedAt: new Date() } }
      );
      if (!takeover) {
        res.setHeader("Retry-After", "1");
        throw new AppError("This request is already being processed", 503);
      }
    }
    storeThenSend(res, claim);
    next();
  });
