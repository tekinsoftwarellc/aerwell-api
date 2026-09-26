import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { isValidObjectId } from "mongoose";
import { StaffCredential, StaffSession } from "../../api/auth/auth.model.js";
import { signingKey } from "../../api/auth/password.js";
import { type StaffDocument, StaffMember } from "../../api/staff/staff.model.js";
import { env } from "../../config/env.js";
import { ForbiddenError, UnauthorizedError } from "../errors/AppError.js";

const expired = () => new UnauthorizedError("Session expired", "UNAUTHENTICATED");

export interface VerifiedAccess {
  staff: StaffDocument;
  sessionId: string;
  credentialVersion: number;
  /** Access-token expiry (epoch ms). */
  expiresAtMs: number;
}

/** Signature, issuer, audience and claim shape only; no database reads. */
function decodeAccessToken(token: string): jwt.JwtPayload {
  const key = signingKey();
  try {
    const value = jwt.verify(token, key, {
      algorithms: ["HS256"],
      issuer: "aerwell-api",
      audience: "aerwell-api",
    });
    if (typeof value === "string" || !isValidObjectId(value.sub) || !isValidObjectId(value["sid"]))
      throw new Error("Invalid claims");
    return value;
  } catch {
    throw expired();
  }
}

/** The session is live and the credential version is current (logout, rotation, revocation). */
export async function sessionIsLive(
  staff: Pick<StaffDocument, "_id" | "organizationId">,
  sessionId: string,
  credentialVersion: number
): Promise<boolean> {
  const [session, credential] = await Promise.all([
    StaffSession.exists({
      _id: sessionId,
      staffId: staff._id,
      organizationId: staff.organizationId,
      credentialVersion,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }),
    StaffCredential.exists({
      staffId: staff._id,
      organizationId: staff.organizationId,
      version: credentialVersion,
    }),
  ]);
  return Boolean(session && credential);
}

export async function activeStaff(staffId: unknown) {
  const staff = await StaffMember.findOne({
    _id: staffId,
    organizationId: env.AERWELL_ORG_ID,
    deletedAt: null,
  });
  return staff?.accountStatus === "active" ? staff : null;
}

/**
 * The one access-token check: HTTP requests and WebSocket upgrades both use it,
 * so a socket is refused for exactly the reasons a request would be.
 */
export async function verifyAccessToken(token: string): Promise<VerifiedAccess> {
  const payload = decodeAccessToken(token);
  const staff = await activeStaff(payload.sub);
  if (!staff)
    throw new ForbiddenError(
      "This account doesn't have access to Aerwell. Contact your admin.",
      "NOT_ALLOWED_ON_AERWELL"
    );
  const sessionId = String(payload["sid"]);
  const credentialVersion = payload["ver"] as number;
  if (!(await sessionIsLive(staff, sessionId, credentialVersion))) throw expired();
  return { staff, sessionId, credentialVersion, expiresAtMs: (payload.exp ?? 0) * 1000 };
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    signingKey();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw expired();
    const { staff } = await verifyAccessToken(header.slice(7));
    req.staff = staff;
    req.organizationId = staff.organizationId;
    next();
  } catch (error) {
    next(error);
  }
};
