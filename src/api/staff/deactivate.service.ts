import type { Request } from "express";
import mongoose, { type ClientSession } from "mongoose";
import { ForbiddenError, NotFoundError, ValidationError } from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { emailConfigured, sendEmail } from "../../common/services/email.service.js";
import { AuditEvent } from "../audit/audit.js";
import { StaffSession } from "../auth/auth.model.js";
import { Invite } from "../invite/invite.model.js";
import { OrganizationSettings } from "../settings/settings.model.js";
import { settingsFor } from "../settings/settings.service.js";
import { StaffMember } from "./staff.model.js";
import { staffTarget } from "./staff.service.js";
async function checkTargets(req: Request, ids: string[], session: ClientSession) {
  const by = actor(req);
  // All deactivations write the same organization row to prevent last-admin write skew.
  await OrganizationSettings.updateOne(
    { organizationId: by.organizationId },
    { $inc: { staffAccessRevision: 1 } },
    { session }
  );
  if (
    !(await StaffMember.exists({
      _id: by._id,
      organizationId: by.organizationId,
      accountStatus: "active",
    }).session(session))
  )
    throw new ForbiddenError();
  const targets = await StaffMember.find({
    _id: { $in: ids },
    organizationId: by.organizationId,
    deletedAt: null,
  }).session(session);
  if (targets.length !== new Set(ids).size) throw new NotFoundError();
  const removesSuper = targets.some(
    (staff) => staff.isSuperAdmin && staff.accountStatus === "active"
  );
  if (
    removesSuper &&
    !(await StaffMember.exists({
      _id: { $nin: ids },
      organizationId: by.organizationId,
      isSuperAdmin: true,
      accountStatus: "active",
      deletedAt: null,
    }).session(session))
  )
    throw new ValidationError("Keep at least one active super admin", "LAST_SUPER_ADMIN");
}
async function applyDeactivation(req: Request, ids: string[], now: Date, session: ClientSession) {
  const by = actor(req);
  const ownership = { staffId: { $in: ids }, organizationId: by.organizationId };
  await StaffMember.updateMany(
    { _id: { $in: ids }, organizationId: by.organizationId },
    {
      $set: {
        accountStatus: "deactivated",
        deactivation: {
          at: now,
          byId: String(by._id),
          reason: req.body.reason,
          notes: req.body.notes,
        },
      },
    },
    { session }
  );
  await StaffSession.updateMany(ownership, { $set: { revokedAt: now } }, { session });
  await Invite.updateMany(
    { ...ownership, status: "pending" },
    { $set: { status: "revoked" } },
    { session }
  );
  const events = await AuditEvent.create(
    ids.map((id) => ({
      organizationId: by.organizationId,
      actorId: String(by._id),
      action: "deactivated",
      targetType: "StaffMember",
      targetId: id,
      requestId: req.requestId,
    })),
    { session, ordered: true }
  );
  return String(events[0]?._id);
}
async function notifyDeactivation(req: Request, ids: string[]) {
  if (!req.body.notify) return "not_requested";
  if (!emailConfigured()) return "unconfigured";
  let status = "sent";
  const targets = await StaffMember.find({
    _id: { $in: ids },
    organizationId: actor(req).organizationId,
  });
  for (const target of targets)
    try {
      await sendEmail({
        to: target.email,
        subject: "Aerwell staff access deactivated",
        text: "Your Aerwell staff access has been deactivated. Contact your administrator for details.",
      });
    } catch {
      status = "failed";
    }
  return status;
}
export async function deactivateStaff(req: Request, ids: string[]) {
  const by = actor(req);
  if (ids.includes(String(by._id)))
    throw new ValidationError("You cannot deactivate yourself", "CANNOT_DEACTIVATE_SELF");
  for (const id of ids) await staffTarget(req, id);
  await settingsFor(by.organizationId);
  const session = await mongoose.startSession();
  const now = new Date();
  let auditEventId = "";
  try {
    await session.withTransaction(async () => {
      await checkTargets(req, ids, session);
      auditEventId = await applyDeactivation(req, ids, now, session);
    });
  } finally {
    await session.endSession();
  }
  return {
    deactivatedAt: now,
    deactivatedBy: String(by._id),
    auditEventId,
    deliveryStatus: await notifyDeactivation(req, ids),
  };
}
