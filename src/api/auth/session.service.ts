import jwt from "jsonwebtoken";
import { UnauthorizedError } from "../../common/errors/AppError.js";
import { env } from "../../config/env.js";
import { StaffMember } from "../staff/staff.model.js";
import { StaffCredential, StaffSession } from "./auth.model.js";
import { hashToken, opaqueToken, signingKey } from "./password.js";
const invalid = () => new UnauthorizedError("Session expired", "UNAUTHENTICATED");
export async function issueSession(staffId: string, version: number) {
  const key = signingKey();
  const refreshToken = opaqueToken();
  const row = await StaffSession.create({
    organizationId: env.AERWELL_ORG_ID,
    staffId,
    credentialVersion: version,
    currentHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + 30 * 86400_000),
  });
  const accessToken = jwt.sign({ sid: String(row._id), ver: version }, key, {
    algorithm: "HS256",
    issuer: "aerwell-api",
    audience: "aerwell-api",
    subject: staffId,
    expiresIn: "15m",
  });
  return { accessToken, refreshToken };
}
export async function refreshSession(token: string) {
  const key = signingKey();
  const hash = hashToken(token);
  const nextToken = opaqueToken();
  const row = await StaffSession.findOneAndUpdate(
    {
      organizationId: env.AERWELL_ORG_ID,
      currentHash: hash,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { currentHash: hashToken(nextToken) }, $push: { usedHashes: hash } },
    { new: true }
  );
  if (!row) {
    await StaffSession.updateMany(
      { organizationId: env.AERWELL_ORG_ID, usedHashes: hash },
      { $set: { revokedAt: new Date() } }
    );
    throw invalid();
  }
  const staff = await StaffMember.findOne({
    _id: row.staffId,
    organizationId: row.organizationId,
    accountStatus: "active",
    deletedAt: null,
  });
  const credential = await StaffCredential.findOne({
    staffId: row.staffId,
    version: row.credentialVersion,
  });
  if (!(staff && credential)) {
    await StaffSession.updateOne({ _id: row._id }, { $set: { revokedAt: new Date() } });
    throw invalid();
  }
  return {
    refreshToken: nextToken,
    accessToken: jwt.sign({ sid: String(row._id), ver: row.credentialVersion }, key, {
      algorithm: "HS256",
      issuer: "aerwell-api",
      audience: "aerwell-api",
      subject: String(staff._id),
      expiresIn: "15m",
    }),
  };
}
export async function logoutSession(token: string) {
  const hash = hashToken(token);
  await StaffSession.updateMany(
    { organizationId: env.AERWELL_ORG_ID, $or: [{ currentHash: hash }, { usedHashes: hash }] },
    { $set: { revokedAt: new Date() } }
  );
}
export const revokeStaffSessions = async (staffId: string) => {
  await StaffSession.updateMany(
    { staffId, organizationId: env.AERWELL_ORG_ID },
    { $set: { revokedAt: new Date() } }
  );
};
