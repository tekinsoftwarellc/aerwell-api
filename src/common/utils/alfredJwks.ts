import { type JsonWebKey, createPublicKey } from "node:crypto";
import { env } from "../../config/env.js";
import { UnauthorizedError } from "../errors/AppError.js";

/**
 * alfred-auth RS256 key resolution (contracts §1.6 / §2.2).
 *
 * A key provider maps a token header `kid` to the PEM that verifies it. Production
 * uses the JWKS fetcher below; tests inject the test keypair's public PEM via
 * `setAlfredKeyProvider`, so no live alfred-auth is ever required to run the suite.
 */
export type AlfredKeyProvider = (kid: string) => Promise<string>;

/** JWKS cache TTL — contracts §1.1: 10 minutes, plus one forced re-fetch on a kid miss. */
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
/** A forced re-fetch needs the cache to be this old, so random `kid`s cannot make us hammer alfred-auth. */
const MIN_REFETCH_INTERVAL_MS = 30 * 1000;

interface JwksResponse {
  keys: (JsonWebKey & { kid?: string })[];
}

export const createJwksKeyProvider = (url: string): AlfredKeyProvider => {
  let cache: { pems: Map<string, string>; fetchedAt: number } | null = null;

  const load = async (): Promise<Map<string, string>> => {
    const res = await fetch(url);
    if (!res.ok) throw new UnauthorizedError("Unable to verify token signing key");
    const body = (await res.json()) as JwksResponse;
    const pems = new Map<string, string>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid) continue;
      pems.set(
        jwk.kid,
        createPublicKey({ key: jwk, format: "jwk" }).export({
          type: "spki",
          format: "pem",
        }) as string
      );
    }
    cache = { pems, fetchedAt: Date.now() };
    return pems;
  };

  return async (kid: string): Promise<string> => {
    const fresh = cache && Date.now() - cache.fetchedAt < JWKS_CACHE_TTL_MS;
    let pems = fresh && cache ? cache.pems : await load();

    if (
      !pems.has(kid) &&
      fresh &&
      cache &&
      Date.now() - cache.fetchedAt >= MIN_REFETCH_INTERVAL_MS
    ) {
      // Key rotation: the signing key may have changed inside the cache window.
      // Exactly one forced re-fetch, then fail closed.
      pems = await load();
    }

    const pem = pems.get(kid);
    if (!pem) throw new UnauthorizedError("Unknown token signing key");
    return pem;
  };
};

let override: AlfredKeyProvider | null = null;
let defaultProvider: AlfredKeyProvider | null = null;

/** Test seam: inject a PEM provider (pass `null` to restore the JWKS fetcher). */
export const setAlfredKeyProvider = (provider: AlfredKeyProvider | null): void => {
  override = provider;
};

export const getAlfredKeyProvider = (): AlfredKeyProvider => {
  if (override) return override;
  if (!env.ALFRED_AUTH_JWKS_URL) {
    throw new UnauthorizedError("Service tokens are not enabled (ALFRED_AUTH_JWKS_URL unset)");
  }
  defaultProvider ??= createJwksKeyProvider(env.ALFRED_AUTH_JWKS_URL);
  return defaultProvider;
};
