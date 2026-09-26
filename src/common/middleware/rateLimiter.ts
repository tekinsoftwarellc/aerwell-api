import type { NextFunction, Request, Response } from "express";
import { env } from "../../config/env.js";
import { ServiceResponse } from "../models/serviceResponse.js";
import type { CacheService } from "../services/cache.service.js";

const RATE_LIMIT_PREFIX = "rl:";
const MIN_DEV_RATE_LIMIT_MAX = 10_000;

const maxRequestsPerWindow =
  env.NODE_ENV === "development"
    ? Math.max(env.RATE_LIMIT_MAX, MIN_DEV_RATE_LIMIT_MAX)
    : env.RATE_LIMIT_MAX;

const windowSeconds = Math.ceil(env.RATE_LIMIT_WINDOW_MS / 1000);

export const requestIp = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? "unknown";

export interface ScopedRateLimitOptions {
  /** Cache key prefix, e.g. "rl:login:" — keep unique per limiter. */
  prefix: string;
  windowSeconds: number;
  max: number;
  /** Derives the bucket key from the request. Defaults to client IP. */
  keyFn?: (req: Request) => string;
  message?: string;
}

/**
 * Cache-backed fixed-window rate limiter scoped to a route (SEC-H1/H2).
 * Unlike the global limiter below, window/max are per-limiter and the
 * bucket key can be derived from the request body (e.g. per-email).
 */
export const createScopedRateLimiter = (cache: CacheService, options: ScopedRateLimitOptions) => {
  const { prefix, max, keyFn, message } = options;
  return async function scopedRateLimit(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const key = `${prefix}${keyFn ? keyFn(req) : requestIp(req)}`;

    const count = await cache.increment(key, options.windowSeconds);

    if (count > max) {
      const response = ServiceResponse.error(
        message ?? "Too many requests, please try again later",
        null,
        429
      );
      res.status(response.statusCode).json(response);
      return;
    }

    next();
  };
};

/** Global per-IP limiter applied to every route (config via RATE_LIMIT_* env). */
export const createRateLimiter = (cache: CacheService) =>
  createScopedRateLimiter(cache, {
    prefix: RATE_LIMIT_PREFIX,
    windowSeconds,
    max: maxRequestsPerWindow,
  });
