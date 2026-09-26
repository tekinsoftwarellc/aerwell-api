import { env } from "../../config/env.js";
import { logger } from "../utils/logger.js";

/** Aerwell service-to-service client credentials; no requests are made at startup. */
interface OAuthTokenResponse {
  // biome-ignore lint/style/useNamingConvention: external OAuth protocol field name.
  readonly access_token: string;
  // biome-ignore lint/style/useNamingConvention: external OAuth protocol field name.
  readonly expires_in: number;
}

/** Keyed by `audience|scope` — one token per callee (contracts §2.2: one service per token). */
const cache = new Map<string, { token: string; expiresAt: number }>();

/** Test seam — force a re-fetch on the next call. */
export const clearServiceTokenCache = (): void => cache.clear();

export class ServiceTokenUnavailableError extends Error {}

/**
 * Wall-clock ceiling on any single call to another platform service. A *hung* alfred is
 * the likeliest outage mode, and without this the caller waits on undici's 300s headers
 * timeout — which would block a back-office page render behind a black hole. Shared by
 * every alfred caller so the degraded paths actually fire.
 */
export const ALFRED_TIMEOUT_MS = 5_000;

/**
 * Fetch (or reuse) a service token for calling `aud`. Throws
 * `ServiceTokenUnavailableError` when alfred-auth credentials are not configured —
 * callers decide whether that means "skip the re-check" or "fail closed".
 */
export const getServiceToken = async (audience = "alfred-api", scope?: string): Promise<string> => {
  const key = `${audience}|${scope ?? ""}`;
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  if (!(env.ALFRED_AUTH_URL && env.ALFRED_AUTH_CLIENT_ID && env.ALFRED_AUTH_CLIENT_SECRET)) {
    throw new ServiceTokenUnavailableError(
      "ALFRED_AUTH_URL / ALFRED_AUTH_CLIENT_ID / ALFRED_AUTH_CLIENT_SECRET not configured"
    );
  }

  const basic = Buffer.from(
    `${env.ALFRED_AUTH_CLIENT_ID}:${env.ALFRED_AUTH_CLIENT_SECRET}`
  ).toString("base64");

  let res: Response;
  try {
    res = await fetch(`${env.ALFRED_AUTH_URL}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // biome-ignore lint/style/useNamingConvention: external OAuth protocol field name.
        Authorization: `Basic ${basic}`,
      },
      // `audience` is mandatory at alfred-auth (one callee per token, §2.2).
      body: new URLSearchParams({
        // biome-ignore lint/style/useNamingConvention: external OAuth protocol field name.
        grant_type: "client_credentials",
        audience,
        ...(scope ? { scope } : {}),
      }).toString(),
      signal: AbortSignal.timeout(ALFRED_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err }, "alfred-auth service token request failed (network error)");
    throw new ServiceTokenUnavailableError((err as Error).message);
  }

  if (!res.ok) {
    logger.warn({ status: res.status }, "alfred-auth service token request failed");
    throw new ServiceTokenUnavailableError(`alfred-auth /oauth/token responded ${res.status}`);
  }

  const body = (await res.json()) as OAuthTokenResponse;
  cache.set(key, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in - 30) * 1000,
  });
  return body.access_token;
};
