import type { Request } from "express";
import mongoose from "mongoose";
import { ConflictError, NotFoundError, UnauthorizedError } from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { emailConfigured, sendEmail } from "../../common/services/email.service.js";
import { env } from "../../config/env.js";
import { AuditEvent, audit } from "../audit/audit.js";
import { StaffCredential } from "../auth/auth.model.js";
import { hashPassword, hashToken, opaqueToken } from "../auth/password.js";
import { inviteAccepted } from "../notification/producers.js";
import { Role } from "../role/role.model.js";
import { guardGrant } from "../settings/settings.service.js";
import { type StaffDocument, StaffMember } from "../staff/staff.model.js";
import { Invite } from "./invite.model.js";
export async function sendInvite(staff: StaffDocument) {
  const token = opaqueToken();
  await Invite.updateMany(
    { organizationId: staff.organizationId, staffId: staff._id, status: "pending" },
    { $set: { status: "revoked" } }
  );
  const invite = await Invite.create({
    organizationId: staff.organizationId,
    staffId: staff._id,
    email: staff.email,
    roleId: staff.roleId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 7 * 86400_000),
  });
  if (emailConfigured()) {
    try {
      await sendEmail({
        to: staff.email,
        subject: "Your Aerwell staff invitation",
        text: `Set up your Aerwell account within 7 days: ${env.ADMIN_BASE_URL}/accept-invite#token=${token}`,
      });
      invite.deliveryStatus = "sent";
      invite.sentAt = new Date();
    } catch {
      invite.deliveryStatus = "failed";
    }
    await invite.save();
  }
  const result = invite.toObject();
  return {
    _id: result._id,
    email: result.email,
    roleId: result.roleId,
    staffId: result.staffId,
    status: result.status,
    expiresAt: result.expiresAt,
    sentAt: result.sentAt,
    deliveryStatus: result.deliveryStatus,
  };
}
export async function createInvite(req: Request) {
  const organizationId = actor(req).organizationId;
  const role = await Role.findOne({ _id: req.body.roleId, organizationId });
  if (!role) throw new NotFoundError();
  await guardGrant(req, role.permissions);
  let staff = await StaffMember.findOne({ organizationId, email: req.body.email });
  if (staff && staff.accountStatus !== "pending_onboarding")
    throw new ConflictError(
      "An account already exists for this email",
      undefined,
      "STAFF_EMAIL_EXISTS"
    );
  staff ??= await StaffMember.create({
    organizationId,
    email: req.body.email,
    firstName: "Invited",
    lastName: "Staff",
    roleId: role._id,
  });
  const result = await sendInvite(staff);
  await audit(req, "invited", "StaffMember", String(staff._id));
  return result;
}
export async function changeInvite(req: Request, revoke = false) {
  const organizationId = actor(req).organizationId;
  const invite = await Invite.findOne({ _id: req.params["id"], organizationId, status: "pending" });
  if (!invite) throw new NotFoundError();
  const staff = await StaffMember.findOne({
    _id: invite.staffId,
    organizationId,
    accountStatus: "pending_onboarding",
  });
  if (!staff) throw new NotFoundError();
  if (revoke) {
    invite.status = "revoked";
    await invite.save();
    await audit(req, "revoked", "Invite", String(invite._id));
    return invite;
  }
  const result = await sendInvite(staff);
  await audit(req, "resent", "Invite", String(invite._id));
  return result;
}
export async function acceptInvite(input: {
  token: string;
  password: string;
  firstName: string;
  lastName: string;
}) {
  const passwordHash = await hashPassword(input.password);
  const session = await mongoose.startSession();
  let joined: StaffDocument | null = null;
  try {
    await session.withTransaction(async () => {
      const invite = await Invite.findOneAndUpdate(
        {
          tokenHash: hashToken(input.token),
          organizationId: env.AERWELL_ORG_ID,
          status: "pending",
          expiresAt: { $gt: new Date() },
        },
        { $set: { status: "accepted" } },
        { new: true, session }
      );
      if (!invite)
        throw new UnauthorizedError("This invitation is invalid or expired", "INVITE_INVALID");
      const staff = await StaffMember.findOneAndUpdate(
        {
          _id: invite.staffId,
          organizationId: invite.organizationId,
          accountStatus: "pending_onboarding",
          deletedAt: null,
        },
        { $set: { firstName: input.firstName, lastName: input.lastName, accountStatus: "active" } },
        { new: true, session }
      );
      if (!staff)
        throw new UnauthorizedError("This invitation is invalid or expired", "INVITE_INVALID");
      joined = staff;
      await StaffCredential.create(
        [{ staffId: staff._id, organizationId: staff.organizationId, passwordHash }],
        { session }
      );
      await AuditEvent.create(
        [
          {
            organizationId: staff.organizationId,
            actorId: String(staff._id),
            action: "invite_accepted",
            targetType: "StaffMember",
            targetId: String(staff._id),
          },
        ],
        { session }
      );
    });
  } finally {
    await session.endSession();
  }
  if (joined) await inviteAccepted(joined);
  return { accepted: true };
}
