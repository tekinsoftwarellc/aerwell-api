import { randomInt } from "node:crypto";
import { AppError, ForbiddenError, UnauthorizedError } from "../../common/errors/AppError.js";
import { emailConfigured, sendEmail } from "../../common/services/email.service.js";
import { env } from "../../config/env.js";
import { AuditEvent } from "../audit/audit.js";
import { OrganizationSettings } from "../settings/settings.model.js";
import { type StaffDocument, StaffMember } from "../staff/staff.model.js";
import { AuthChallenge, StaffCredential } from "./auth.model.js";
import {
  equalizePassword,
  hashCode,
  hashPassword,
  hashToken,
  opaqueToken,
  signingKey,
  verifyPassword,
} from "./password.js";
import { issueSession, revokeStaffSessions } from "./session.service.js";
const invalid = () => new UnauthorizedError("Invalid email or password", "INVALID_CREDENTIALS");
const challengeInvalid = () =>
  new UnauthorizedError("This code or link is invalid or expired", "CHALLENGE_INVALID");
async function completeLogin(staff: StaffDocument, version: number) {
  const tokens = await issueSession(String(staff._id), version);
  await StaffMember.updateOne({ _id: staff._id }, { $set: { lastLoginAt: new Date() } });
  await AuditEvent.create({
    organizationId: staff.organizationId,
    actorId: String(staff._id),
    action: "signed_in",
    targetType: "StaffMember",
    targetId: String(staff._id),
  });
  return tokens;
}
async function verifyCredentials(email: string, password: string) {
  signingKey();
  const staff = await StaffMember.findOne({
    organizationId: env.AERWELL_ORG_ID,
    email: email.toLowerCase(),
    deletedAt: null,
  });
  const credential = staff
    ? await StaffCredential.findOne({
        staffId: staff._id,
        organizationId: staff.organizationId,
      }).select("+passwordHash")
    : null;
  if (!(staff && credential)) {
    await equalizePassword(password);
    throw invalid();
  }
  if (credential.lockedUntil && credential.lockedUntil > new Date())
    throw new AppError(
      "Your account is temporarily locked. Try again in 15 minutes.",
      423,
      true,
      undefined,
      "ACCOUNT_LOCKED"
    );
  if (!(await verifyPassword(password, credential.passwordHash))) {
    const updated = await StaffCredential.findOneAndUpdate(
      { _id: credential._id },
      { $inc: { failedAttempts: 1 } },
      { new: true }
    );
    if ((updated?.failedAttempts ?? 0) >= 5)
      await StaffCredential.updateOne(
        { _id: credential._id },
        { $set: { lockedUntil: new Date(Date.now() + 15 * 60_000) } }
      );
    throw invalid();
  }
  if (staff.accountStatus !== "active")
    throw new ForbiddenError(
      "This account doesn't have access to Aerwell. Contact your admin.",
      "NOT_ALLOWED_ON_AERWELL"
    );
  await StaffCredential.updateOne(
    { _id: credential._id },
    { $set: { failedAttempts: 0 }, $unset: { lockedUntil: 1 } }
  );
  return { staff, credential };
}
export async function loginStaff(email: string, password: string) {
  const { staff, credential } = await verifyCredentials(email, password);
  const settings = await OrganizationSettings.findOne({ organizationId: staff.organizationId });
  if (!settings?.security?.requireTwoFactor) return completeLogin(staff, credential.version);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const challenge = await AuthChallenge.create({
    organizationId: staff.organizationId,
    staffId: staff._id,
    kind: "otp",
    tokenHash: hashCode(code),
    credentialVersion: credential.version,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  try {
    await sendEmail({
      to: staff.email,
      subject: "Aerwell sign-in code",
      text: `Your Aerwell sign-in code is ${code}. It expires in 10 minutes.`,
    });
  } catch (error) {
    await AuthChallenge.deleteOne({ _id: challenge._id });
    throw error;
  }
  return { challenge: "2FA_REQUIRED" as const, challengeId: String(challenge._id) };
}
export async function verifyOtp(challengeId: string, code: string) {
  const challenge = await AuthChallenge.findOneAndUpdate(
    {
      _id: challengeId,
      organizationId: env.AERWELL_ORG_ID,
      kind: "otp",
      consumedAt: null,
      expiresAt: { $gt: new Date() },
      attempts: { $lt: 5 },
    },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!challenge || challenge.tokenHash !== hashCode(code)) throw challengeInvalid();
  const claimed = await AuthChallenge.findOneAndUpdate(
    { _id: challenge._id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
    { new: true }
  );
  if (!claimed) throw challengeInvalid();
  const staff = await StaffMember.findOne({
    _id: challenge.staffId,
    organizationId: challenge.organizationId,
    accountStatus: "active",
    deletedAt: null,
  });
  const credential = await StaffCredential.findOne({
    staffId: challenge.staffId,
    version: challenge.credentialVersion,
  });
  if (!(staff && credential)) throw challengeInvalid();
  return completeLogin(staff, credential.version);
}
export async function forgotPassword(email: string) {
  if (!emailConfigured()) return;
  const staff = await StaffMember.findOne({
    email: email.toLowerCase(),
    organizationId: env.AERWELL_ORG_ID,
    accountStatus: "active",
    deletedAt: null,
  });
  const credential = staff ? await StaffCredential.findOne({ staffId: staff._id }) : null;
  if (!(staff && credential)) return;
  const token = opaqueToken();
  const challenge = await AuthChallenge.create({
    organizationId: staff.organizationId,
    staffId: staff._id,
    kind: "reset",
    tokenHash: hashToken(token),
    credentialVersion: credential.version,
    expiresAt: new Date(Date.now() + 30 * 60_000),
  });
  try {
    await sendEmail({
      to: staff.email,
      subject: "Reset your Aerwell password",
      text: `Reset your password using this link within 30 minutes: ${env.ADMIN_BASE_URL}/reset-password#token=${token}`,
    });
  } catch {
    await AuthChallenge.deleteOne({ _id: challenge._id });
  }
}
export async function resetPassword(token: string, password: string) {
  const passwordHash = await hashPassword(password);
  const challenge = await AuthChallenge.findOneAndUpdate(
    {
      tokenHash: hashToken(token),
      organizationId: env.AERWELL_ORG_ID,
      kind: "reset",
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { consumedAt: new Date() } },
    { new: true }
  );
  if (!challenge) throw challengeInvalid();
  const staff = await StaffMember.exists({
    _id: challenge.staffId,
    organizationId: challenge.organizationId,
    accountStatus: "active",
    deletedAt: null,
  });
  if (!staff) throw challengeInvalid();
  const result = await StaffCredential.updateOne(
    { staffId: challenge.staffId, version: challenge.credentialVersion },
    { $set: { passwordHash, failedAttempts: 0 }, $inc: { version: 1 }, $unset: { lockedUntil: 1 } }
  );
  if (!result.modifiedCount) throw challengeInvalid();
  await revokeStaffSessions(String(challenge.staffId));
  await AuditEvent.create({
    organizationId: challenge.organizationId,
    actorId: String(challenge.staffId),
    action: "password_reset",
    targetType: "StaffMember",
    targetId: String(challenge.staffId),
  });
}
export async function changePassword(
  staff: StaffDocument,
  currentPassword: string,
  password: string
) {
  const credential = await StaffCredential.findOne({ staffId: staff._id }).select("+passwordHash");
  if (!(credential && (await verifyPassword(currentPassword, credential.passwordHash))))
    throw invalid();
  const passwordHash = await hashPassword(password);
  const result = await StaffCredential.updateOne(
    { _id: credential._id, version: credential.version },
    { $set: { passwordHash, failedAttempts: 0 }, $inc: { version: 1 }, $unset: { lockedUntil: 1 } }
  );
  if (!result.modifiedCount) throw challengeInvalid();
  await revokeStaffSessions(String(staff._id));
  await AuditEvent.create({
    organizationId: staff.organizationId,
    actorId: String(staff._id),
    action: "password_changed",
    targetType: "StaffMember",
    targetId: String(staff._id),
  });
}
