import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger.js";

const HEADER_NAME = "X-Request-ID";

/**
 * An inbound `X-Request-ID` is attacker-controlled: it is echoed into the response header and
 * stamped on every log line of the request, so an unchecked value lets a direct client write
 * CRLF-separated forged log records (or unbounded junk) into this service's logs.
 *
 * Anything outside this pattern is DISCARDED and replaced with a fresh UUID rather than
 * sanitized — a partially-scrubbed id is still caller-authored. Kept byte-identical to the
 * alfred-auth and alfred-api hardening so the three services agree on what a correlation id is.
 * Hyphens are in the set, so a plain UUID from a legitimate caller still passes through.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export const correlationId = (req: Request, res: Response, next: NextFunction): void => {
  // Express hands back an ARRAY when the header is sent twice; only a lone string can be trusted.
  const incoming = req.headers[HEADER_NAME.toLowerCase()];
  const id =
    typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();

  req.requestId = id;
  res.setHeader(HEADER_NAME, id);

  // Attach a child logger with requestId so every downstream log line includes it
  req.log = logger.child({ requestId: id });

  next();
};
