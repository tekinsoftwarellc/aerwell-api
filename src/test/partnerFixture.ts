import { generateKeyPairSync, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
import { UnauthorizedError } from "../common/errors/AppError.js";
import { setAlfredKeyProvider } from "../common/utils/alfredJwks.js";
import type { createServer } from "../server.js";

/** An RS256 keypair standing in for alfred-auth: no live JWKS is ever fetched in tests. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
export const KID = "alfred-test-kid";
export const ALFRED_ORG = "alfred-org-aerwell";
export const ACCOUNT = "6710bb4e2f9c1a0031d5e7a2";

export function installAlfredKeys() {
  setAlfredKeyProvider(async (kid) => {
    if (kid !== KID) throw new UnauthorizedError("Unknown token signing key");
    return publicKey;
  });
}
export const removeAlfredKeys = () => setAlfredKeyProvider(null);

interface TokenOptions {
  accountId?: string | null;
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  expiresIn?: number;
}
/** A valid alfred-auth service token for one member (`accountId: null` = org level, no `act`). */
export function alfredToken({
  accountId = ACCOUNT,
  claims = {},
  header = {},
  expiresIn = 300,
}: TokenOptions = {}) {
  const payload = {
    sub: "svc:alfred-api",
    realm: "service",
    svc: "alfred-api",
    scope: "partner.read",
    ...(accountId ? { act: { sub: accountId, realm: "member", orgId: ALFRED_ORG } } : {}),
    ...claims,
  };
  const options = {
    algorithm: "RS256",
    issuer: "alfred-auth",
    audience: "partner-aerwell",
    expiresIn,
    keyid: KID,
    ...(header as object),
  } as Record<string, unknown>;
  // `keyid: null` means a token with no `kid` header at all.
  if (options["keyid"] === null) options["keyid"] = undefined;
  if (options["keyid"] === undefined) delete options["keyid"];
  return jwt.sign(payload, privateKey, options as jwt.SignOptions);
}

/** supertest against the real server, with the contract headers Alfred always sends. */
export function alfredClient(app: ReturnType<typeof createServer>, token = alfredToken()) {
  const base = (r: request.Test) =>
    r.set("authorization", `Bearer ${token}`).set("x-contract-version", "1");
  return {
    get: (path: string) => base(request(app).get(`/api/v1/alfred${path}`)),
    post: (path: string, body: unknown = {}, key: string = randomUUID()) =>
      base(request(app).post(`/api/v1/alfred${path}`))
        .set("idempotency-key", key)
        .send(body as object),
  };
}
