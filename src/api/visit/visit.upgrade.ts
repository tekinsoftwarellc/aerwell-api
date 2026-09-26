import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import type { Request } from "express";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../common/errors/AppError.js";
import { type VerifiedAccess, verifyAccessToken } from "../../common/middleware/authenticate.js";
import { logger } from "../../common/utils/logger.js";
import { env } from "../../config/env.js";
import { permits, resolvePermissions } from "../role/permission.js";
import { visitTarget } from "./visit.service.js";

export const VISIT_WS_PATH = /^\/ws\/appointments\/([a-f\d]{24})\/transcription$/i;
/** Browsers cannot set headers on a WebSocket, so the access token rides as a subprotocol. */
export const WS_PROTOCOL = "aerwell.v1";
const BEARER_PREFIX = "bearer.";

/** The authenticated actor a socket acts as; shaped like a request so the HTTP scope helpers apply. */
export type SocketActor = Pick<
  Request,
  "staff" | "requestId" | "params" | "permission" | "permissions"
>;
export interface UpgradeContext {
  actor: SocketActor;
  access: VerifiedAccess;
  appointmentId: string;
  memberId: string;
  organizationId: string;
}

function bearerFrom(req: IncomingMessage) {
  const offered = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((value) => value.trim());
  const token = offered
    .find((value) => value.startsWith(BEARER_PREFIX))
    ?.slice(BEARER_PREFIX.length);
  if (!(offered.includes(WS_PROTOCOL) && token))
    throw new UnauthorizedError("Session expired", "UNAUTHENTICATED");
  return token;
}

function assertOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  const allowed = env.CORS_ORIGIN.split(",").map((value) => value.trim());
  // Browsers always send Origin; a cross-site page is refused even with a token.
  if (origin && !allowed.includes("*") && !allowed.includes(origin))
    throw new ForbiddenError("Origin not allowed", "ORIGIN_NOT_ALLOWED");
}

/**
 * Upgrade-time authorization, the same checks an HTTP request gets: token,
 * session and credential version (verifyAccessToken), then APPOINTMENTS edit,
 * CLINICAL_NOTES edit, org, own and member scope (visitTarget).
 */
export async function authorizeUpgrade(req: IncomingMessage): Promise<UpgradeContext> {
  const match = VISIT_WS_PATH.exec(new URL(req.url ?? "/", "http://localhost").pathname);
  if (!match?.[1]) throw new NotFoundError("Route not found");
  assertOrigin(req);
  const access = await verifyAccessToken(bearerFrom(req));
  const permissions = await resolvePermissions(access.staff);
  if (!permits(permissions.APPOINTMENTS.level, "edit")) throw new ForbiddenError();
  const actor: SocketActor = {
    staff: access.staff,
    requestId: randomUUID(),
    params: { id: match[1] },
    permission: permissions.APPOINTMENTS,
    permissions,
  };
  const appointment = await visitTarget(actor, true);
  return {
    actor,
    access,
    appointmentId: String(appointment._id),
    memberId: String(appointment.memberId),
    organizationId: appointment.organizationId,
  };
}

/** Refuse before the handshake: a plain HTTP status and a machine code, nothing else. */
export function refuseUpgrade(socket: Duplex, error: unknown) {
  const status = error instanceof AppError ? error.statusCode : 500;
  const code = error instanceof AppError ? (error.code ?? "REFUSED") : "INTERNAL_ERROR";
  if (status >= 500)
    logger.error(
      { errorType: error instanceof Error ? error.name : "Unknown" },
      "Visit socket upgrade failed"
    );
  const body = JSON.stringify({ code });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}
