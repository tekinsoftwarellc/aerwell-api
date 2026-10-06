import {
  ServiceTokenUnavailableError,
  clearServiceTokenCache,
  getServiceToken,
} from "../../../common/services/serviceTokenClient.js";
import { logger } from "../../../common/utils/logger.js";
import { env } from "../../../config/env.js";
import { partnerContractEnabled } from "../partner.router.js";
import { PartnerOutbox } from "./partnerOutbox.model.js";

const CLAIM_MS = 2 * 60_000;
const WAIT_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 3_600_000;
const EVENTS_SCOPE = "partner.events.write";

type Row = NonNullable<Awaited<ReturnType<typeof claim>>>;
export interface DrainResult {
  sent: number;
  retried: number;
  dead: number;
  rateLimited: boolean;
}

const OPEN = ["pending", "failed", "sending"];
const MAX_SKIPS = 25;

/**
 * Atomically take the next due row. A `sending` row past its lease belonged to a dead process and is
 * taken again. A row waits while an EARLIER event about the same resource is still open, so Alfred
 * never sees a booking cancelled before it was created.
 */
async function claim(now: Date) {
  const organizationId = env.AERWELL_ORG_ID;
  const skipped: unknown[] = [];
  for (let i = 0; i < MAX_SKIPS; i += 1) {
    const next = await PartnerOutbox.findOne({
      organizationId,
      status: { $in: OPEN },
      nextAttemptAt: { $lte: now },
      _id: { $nin: skipped },
    })
      .sort({ nextAttemptAt: 1, _id: 1 })
      .lean();
    if (!next) return null;
    const blocked = await PartnerOutbox.exists({
      organizationId,
      "resource.ref": next.resource?.ref,
      status: { $in: OPEN },
      occurredAt: { $lt: next.occurredAt },
      _id: { $ne: next._id },
    });
    const taken = blocked
      ? null
      : await PartnerOutbox.findOneAndUpdate(
          { _id: next._id, status: next.status, nextAttemptAt: next.nextAttemptAt },
          { $set: { status: "sending", nextAttemptAt: new Date(now.getTime() + CLAIM_MS) } },
          { new: true }
        );
    if (taken) return taken;
    skipped.push(next._id);
  }
  return null;
}

interface Answer {
  status: number;
  retryAfterMs?: number;
  eventId?: string;
}

async function post(row: Row, token: string): Promise<Answer> {
  const res = await fetch(`${env.ALFRED_API_URL}/api/v1/partner/events`, {
    method: "POST",
    headers: {
      // biome-ignore lint/style/useNamingConvention: HTTP header names.
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-contract-version": "1",
    },
    body: JSON.stringify({
      idempotencyKey: row.idempotencyKey,
      type: row.type,
      occurredAt: row.occurredAt,
      ...(row.accountId ? { accountId: row.accountId } : {}),
      resource: row.resource,
      payload: row.payload,
    }),
    signal: AbortSignal.timeout(env.PARTNER_OUTBOX_PUBLISH_TIMEOUT_MS),
  });
  const retryAfter = Number(res.headers.get("retry-after"));
  const body = (await res.json().catch(() => null)) as { data?: { eventId?: unknown } } | null;
  return {
    status: res.status,
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
    ...(typeof body?.data?.eventId === "string" ? { eventId: body.data.eventId } : {}),
  };
}

/** One send. A 401 gets a fresh token and exactly one more try. Anything thrown is "outcome unknown". */
async function attempt(row: Row): Promise<Answer> {
  try {
    const answer = await post(row, await getServiceToken("alfred-api", EVENTS_SCOPE));
    if (answer.status !== 401) return answer;
    clearServiceTokenCache();
    return await post(row, await getServiceToken("alfred-api", EVENTS_SCOPE));
  } catch (error) {
    // Network failure, timeout, or no token: retry later, and say only what kind of failure it was.
    return { status: error instanceof ServiceTokenUnavailableError ? -2 : -1 };
  }
}

const backoff = (attempts: number) =>
  Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);

type Verdict = "sent" | "retried" | "dead" | "rate_limited";

/** Record the outcome. The error kept is a status code or a failure kind, never a response body. */
async function settle(row: Row, answer: Answer, now: Date): Promise<Verdict> {
  const { status } = answer;
  const keep = { lastStatusCode: status > 0 ? status : undefined };
  if (status >= 200 && status < 300) {
    await PartnerOutbox.updateOne(
      { _id: row._id },
      { $set: { status: "sent", alfredEventId: answer.eventId, lastError: null, ...keep } }
    );
    return "sent";
  }
  if (status === 429) {
    const wait = answer.retryAfterMs ?? BASE_BACKOFF_MS;
    await PartnerOutbox.updateOne(
      { _id: row._id },
      {
        $set: {
          status: "pending",
          nextAttemptAt: new Date(now.getTime() + wait),
          lastError: "rate_limited",
          ...keep,
        },
      }
    );
    return "rate_limited";
  }
  if (status === 400 || status === 422) {
    await PartnerOutbox.updateOne(
      { _id: row._id },
      { $set: { status: "dead", lastError: "rejected", ...keep } }
    );
    return "dead";
  }
  if ([403, 404, 409, 410].includes(status)) {
    // Alfred cannot take it right now (suspended, unknown, gone): wait without spending an attempt.
    await PartnerOutbox.updateOne(
      { _id: row._id },
      {
        $set: {
          status: "failed",
          nextAttemptAt: new Date(now.getTime() + WAIT_MS),
          lastError: "refused",
          ...keep,
        },
      }
    );
    return "retried";
  }
  const attempts = row.attempts + 1;
  const dead = attempts >= env.PARTNER_OUTBOX_MAX_ATTEMPTS;
  await PartnerOutbox.updateOne(
    { _id: row._id },
    {
      $set: {
        status: dead ? "dead" : "failed",
        attempts,
        nextAttemptAt: new Date(now.getTime() + backoff(attempts)),
        lastError: status === -2 ? "no_token" : status === -1 ? "unreachable" : "server_error",
        ...keep,
      },
    }
  );
  return dead ? "dead" : "retried";
}

/** Drain due rows, up to the batch size. A 429 stops the batch: every later send would be refused too. */
export async function drainOutbox(now = new Date()): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, retried: 0, dead: 0, rateLimited: false };
  for (let i = 0; i < env.PARTNER_OUTBOX_BATCH_SIZE; i += 1) {
    const row = await claim(now);
    if (!row) break;
    const verdict = await settle(row, await attempt(row), now);
    if (verdict === "rate_limited") {
      result.rateLimited = true;
      break;
    }
    result[verdict === "sent" ? "sent" : verdict === "dead" ? "dead" : "retried"] += 1;
  }
  return result;
}

/** On unless switched off; with no switch it follows the contract and needs Alfred's address and credentials. */
export const partnerOutboxEnabled = (): boolean =>
  env.PARTNER_OUTBOX_ENABLED
    ? env.PARTNER_OUTBOX_ENABLED === "true"
    : partnerContractEnabled() &&
      Boolean(env.ALFRED_API_URL && env.ALFRED_AUTH_URL && env.ALFRED_AUTH_CLIENT_ID);

/** In-process drain every few seconds, one at a time (the claim is atomic, so a second process is safe too). */
export function startPartnerOutbox(): NodeJS.Timeout | undefined {
  if (!partnerOutboxEnabled()) return undefined;
  let draining = false;
  const timer = setInterval(async () => {
    if (draining) return;
    draining = true;
    try {
      await drainOutbox();
    } catch (error) {
      logger.error({ errorType: (error as Error).name }, "outbox drain failed");
    } finally {
      draining = false;
    }
  }, env.PARTNER_OUTBOX_INTERVAL_MS);
  timer.unref();
  return timer;
}
