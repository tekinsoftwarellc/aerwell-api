import {
  ALFRED_TIMEOUT_MS,
  ServiceTokenUnavailableError,
  clearServiceTokenCache,
  getServiceToken,
} from "../../../common/services/serviceTokenClient.js";
import { logger } from "../../../common/utils/logger.js";
import { env } from "../../../config/env.js";
import { PlanGrantOutbox } from "./planGrant.model.js";

const CLAIM_MS = 2 * 60_000;
const WAIT_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 3_600_000;
const SCOPE = "partner.events.write";
const backoff = (attempts: number) => Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);

type Row = NonNullable<Awaited<ReturnType<typeof claim>>>;
const claim = (now: Date) =>
  PlanGrantOutbox.findOneAndUpdate(
    { status: { $in: ["pending", "failed", "sending"] }, nextAttemptAt: { $lte: now } },
    { $set: { status: "sending", nextAttemptAt: new Date(now.getTime() + CLAIM_MS) } },
    { sort: { nextAttemptAt: 1, createdAt: 1 }, new: true }
  );

const post = (row: Row, token: string) =>
  fetch(`${env.ALFRED_API_URL}/internal/plan-grants`, {
    method: "POST",
    headers: {
      // biome-ignore lint/style/useNamingConvention: HTTP header names.
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-contract-version": "1",
    },
    body: JSON.stringify(row.body),
    signal: AbortSignal.timeout(ALFRED_TIMEOUT_MS),
  });

export interface PlanGrantDrain {
  sent: number;
  failed: number;
  dead: number;
}

/**
 * Drain due rows. Any 2xx is success (Alfred dedupes on eventId). A 4xx other than 429 is final:
 * dead-lettered with the status stored (409 PLAN_PAID_SUBSCRIPTION_ACTIVE included). 429, 5xx and
 * network errors retry with backoff; a missing token or Alfred URL waits without spending attempts.
 */
export async function drainPlanGrants(now = new Date()): Promise<PlanGrantDrain> {
  const out: PlanGrantDrain = { sent: 0, failed: 0, dead: 0 };
  for (let i = 0; i < env.PARTNER_OUTBOX_BATCH_SIZE; i += 1) {
    const row = await claim(now);
    if (!row) break;
    const set = (fields: Record<string, unknown>) =>
      PlanGrantOutbox.updateOne({ _id: row._id }, { $set: fields });
    const wait = (ms: number, lastError: string, extra: Record<string, unknown> = {}) =>
      set({ status: "failed", nextAttemptAt: new Date(now.getTime() + ms), lastError, ...extra });
    if (!env.ALFRED_API_URL) {
      await wait(WAIT_MS, "ALFRED_API_URL not configured");
      out.failed += 1;
      continue;
    }
    let res: Response;
    try {
      res = await post(row, await getServiceToken("alfred-api", SCOPE));
      if (res.status === 401) {
        clearServiceTokenCache();
        res = await post(row, await getServiceToken("alfred-api", SCOPE));
      }
    } catch (err) {
      if (err instanceof ServiceTokenUnavailableError) {
        await wait(WAIT_MS, "no_token");
        out.failed += 1;
        continue;
      }
      const attempts = row.attempts + 1;
      const dead = attempts >= env.PARTNER_OUTBOX_MAX_ATTEMPTS;
      if (dead) await set({ status: "dead", attempts, lastError: "unreachable" });
      else await wait(backoff(attempts), "unreachable", { attempts });
      out[dead ? "dead" : "failed"] += 1;
      continue;
    }
    const code = res.status;
    if (res.ok) {
      await set({ status: "sent", sentAt: now, lastStatusCode: code, lastError: null });
      out.sent += 1;
    } else if (code === 429) {
      const raw = Number(res.headers.get("retry-after"));
      await wait((raw > 0 ? raw : 60) * 1000, "rate_limited", { lastStatusCode: code });
      out.failed += 1;
      break;
    } else if (code >= 400 && code < 500) {
      const body = (await res.json().catch(() => null)) as { data?: { code?: unknown } } | null;
      const reason = typeof body?.data?.code === "string" ? `: ${body.data.code}` : "";
      await set({
        status: "dead",
        lastStatusCode: code,
        lastError: `alfred responded ${code}${reason}`,
      });
      out.dead += 1;
    } else {
      const attempts = row.attempts + 1;
      const dead = attempts >= env.PARTNER_OUTBOX_MAX_ATTEMPTS;
      await set({
        status: dead ? "dead" : "failed",
        attempts,
        nextAttemptAt: new Date(now.getTime() + backoff(attempts)),
        lastError: `alfred responded ${code}`,
        lastStatusCode: code,
      });
      out[dead ? "dead" : "failed"] += 1;
    }
  }
  return out;
}

export function startPlanGrantPublisher(): NodeJS.Timeout | undefined {
  if (env.ALFRED_PLAN_GRANTS_ENABLED !== "true") return undefined;
  let draining = false;
  const timer = setInterval(async () => {
    if (draining) return;
    draining = true;
    try {
      await drainPlanGrants();
    } catch (error) {
      logger.error({ errorType: (error as Error).name }, "plan grant drain failed");
    } finally {
      draining = false;
    }
  }, env.PARTNER_OUTBOX_INTERVAL_MS);
  timer.unref();
  return timer;
}
