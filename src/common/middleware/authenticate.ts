import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { isValidObjectId } from "mongoose";
import { StaffCredential, StaffSession } from "../../api/auth/auth.model.js";
import { signingKey } from "../../api/auth/password.js";
import { StaffMember } from "../../api/staff/staff.model.js";
import { env } from "../../config/env.js";
import { ForbiddenError, UnauthorizedError } from "../errors/AppError.js";
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const key = signingKey();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer "))
      throw new UnauthorizedError("Session expired", "UNAUTHENTICATED");
    let payload: jwt.JwtPayload;
    try {
      const value = jwt.verify(header.slice(7), key, {
        algorithms: ["HS256"],
        issuer: "aerwell-api",
        audience: "aerwell-api",
      });
      if (
        typeof value === "string" ||
        !isValidObjectId(value.sub) ||
        !isValidObjectId(value["sid"])
      )
        throw new Error("Invalid claims");
      payload = value;
    } catch {
      throw new UnauthorizedError("Session expired", "UNAUTHENTICATED");
    }
    const staff = await StaffMember.findOne({
      _id: payload.sub,
      organizationId: env.AERWELL_ORG_ID,
      deletedAt: null,
    });
    if (!staff || staff.accountStatus !== "active")
      throw new ForbiddenError(
        "This account doesn't have access to Aerwell. Contact your admin.",
        "NOT_ALLOWED_ON_AERWELL"
      );
    const [session, credential] = await Promise.all([
      StaffSession.exists({
        _id: payload["sid"],
        staffId: staff._id,
        organizationId: staff.organizationId,
        credentialVersion: payload["ver"],
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      }),
      StaffCredential.exists({
        staffId: staff._id,
        organizationId: staff.organizationId,
        version: payload["ver"],
      }),
    ]);
    if (!(session && credential)) throw new UnauthorizedError("Session expired", "UNAUTHENTICATED");
    req.staff = staff;
    req.organizationId = staff.organizationId;
    next();
  } catch (error) {
    next(error);
  }
};
