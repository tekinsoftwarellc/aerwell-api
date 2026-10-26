import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Opt-in cookie session for the three staff admins (same contract in alfred-api,
 * everhaus-api, aerwell-api). A browser admin sends `X-Token-Mode: cookie`; the refresh token
 * then travels in an HttpOnly cookie instead of the JSON body, so page script never holds it.
 * Requests without the header (mobile, scripts) are untouched.
 *
 * Cookie mode is only entered for SAME-SITE browser callers (`Sec-Fetch-Site`). A cross-site
 * admin (dev CloudFront host, a partner's custom domain) would have the cookie blocked by
 * Safari, so it stays on body mode and keeps today's behaviour.
 *
 * CSRF: the cookie is SameSite=Lax and only read on refresh/logout/revoke, which need the
 * non-simple `X-Token-Mode` header and an exact allowlisted Origin. Every other route keeps
 * the Bearer header.
 */
export const TOKEN_MODE_HEADER = "x-token-mode";
export const REFRESH_COOKIE = "__Secure-admin_rt";

export interface TokenCookieOptions {
  /** Exact-match Origin check. Must be false for everything when the CORS list holds "*". */
  isAllowedOrigin: (origin: string) => boolean | Promise<boolean>;
  maxAgeSeconds: number;
  /** Cookie Path: the auth mount, so the cookie is only ever sent to auth routes. */
  cookiePath: string;
  /** Routes (full path) where the cookie stands in for the body refreshToken. */
  readPaths?: RegExp;
  /** Routes where the cookie is cleared. */
  clearPaths?: RegExp;
}

const READ_DEFAULT = /\/(refresh|logout|revoke)$/;
const CLEAR_DEFAULT = /\/(logout|revoke)$/;

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const attrs = (path: string, maxAge: number) =>
  `; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=${maxAge}`;

interface TokenBag {
  refreshToken?: unknown;
  tokens?: TokenBag;
  [key: string]: unknown;
}

function stripRefresh(body: unknown): { body: unknown; refreshToken?: string } {
  const data = (body as { data?: TokenBag } | null)?.data;
  if (!data || typeof data !== "object") return { body };
  if (typeof data.refreshToken === "string") {
    const { refreshToken, ...rest } = data;
    return { body: { ...(body as object), data: rest }, refreshToken };
  }
  if (data.tokens && typeof data.tokens.refreshToken === "string") {
    const { refreshToken, ...restTokens } = data.tokens;
    return {
      body: { ...(body as object), data: { ...data, tokens: restTokens } },
      refreshToken: refreshToken as string,
    };
  }
  return { body };
}

/** Browser, same-site, explicit opt-in. Everything else is left on body mode. */
function inCookieMode(req: Request): boolean {
  if (req.method !== "POST" || req.get(TOKEN_MODE_HEADER) !== "cookie") return false;
  const site = req.get("sec-fetch-site");
  return site === "same-origin" || site === "same-site";
}

function injectCookieToken(req: Request): void {
  const body = req.body as TokenBag | undefined;
  if (typeof body?.refreshToken === "string") return;
  const cookie = readCookie(req.headers.cookie, REFRESH_COOKIE);
  if (cookie) req.body = { ...body, refreshToken: cookie };
}

function patchJson(res: Response, options: TokenCookieOptions, clear: boolean): void {
  const json = res.json.bind(res);
  res.json = (payload: unknown) => {
    if (clear) {
      res.append("Set-Cookie", `${REFRESH_COOKIE}=${attrs(options.cookiePath, 0)}`);
      return json(payload);
    }
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    const { body, refreshToken } = ok
      ? stripRefresh(payload)
      : { body: payload, refreshToken: undefined };
    if (!refreshToken) return json(payload);
    const value = encodeURIComponent(refreshToken);
    res.append(
      "Set-Cookie",
      `${REFRESH_COOKIE}=${value}${attrs(options.cookiePath, options.maxAgeSeconds)}`
    );
    return json(body);
  };
}

export function tokenCookieMode(options: TokenCookieOptions): RequestHandler {
  const readPaths = options.readPaths ?? READ_DEFAULT;
  const clearPaths = options.clearPaths ?? CLEAR_DEFAULT;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!inCookieMode(req)) {
      next();
      return;
    }
    const origin = req.get("origin");
    const allowed = origin
      ? await Promise.resolve()
          .then(() => options.isAllowedOrigin(origin))
          .catch(() => false)
      : false;
    if (!allowed) {
      res
        .status(403)
        .json({ success: false, message: "Cookie sessions are not allowed from this origin" });
      return;
    }
    const path = req.originalUrl.split("?")[0] ?? "";
    if (readPaths.test(path)) injectCookieToken(req);
    patchJson(res, options, clearPaths.test(path));
    next();
  };
}
