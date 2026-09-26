import type { Request } from "express";
import type { FilterQuery } from "mongoose";
import { AppError, ForbiddenError, NotFoundError } from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { emailConfigured } from "../../common/services/email.service.js";
import { AuditEvent, audit } from "../audit/audit.js";
import { Location } from "../location/location.model.js";
import {
  NotificationPreference,
  NotificationRule,
  PREFERENCE_DEFAULTS,
  QUIET_HOURS_DEFAULT,
} from "../notification/preference.model.js";
import { permits, resolvePermissions } from "../role/permission.js";
import type { Permission } from "../role/permission.types.js";
import { Role } from "../role/role.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { OrganizationSettings } from "./settings.model.js";
import { auditQuery } from "./settings.schema.js";
export const settingsFor = async (organizationId: string) =>
  OrganizationSettings.findOneAndUpdate(
    { organizationId },
    { $setOnInsert: { organizationId } },
    { upsert: true, new: true }
  );
export async function organizationProfile(req: Request) {
  const organizationId = actor(req).organizationId;
  const row = await settingsFor(organizationId);
  const { signedDownload } = await import("../upload/upload.service.js");
  const logoUrl = row.logoUploadId
    ? (await signedDownload(String(row.logoUploadId), organizationId)).url
    : row.logoUrl;
  return { ...row.toObject(), logoUrl, locations: await Location.find({ organizationId }).lean() };
}
export async function updateSettings(req: Request, section: "profile" | "regional" | "security") {
  const staff = actor(req);
  await settingsFor(staff.organizationId);
  if (
    req.body.primaryLocationId &&
    !(await Location.exists({
      _id: req.body.primaryLocationId,
      organizationId: staff.organizationId,
    }))
  )
    throw new NotFoundError();
  if (req.body.requireTwoFactor && !emailConfigured())
    throw new AppError(
      "Configure email delivery before requiring two-factor sign-in",
      503,
      true,
      undefined,
      "EMAIL_UNAVAILABLE"
    );
  const fields = Object.fromEntries(
    Object.entries(req.body).map(([key, value]) => [
      section === "security" ? `security.${key}` : key,
      value,
    ])
  );
  const result = await OrganizationSettings.findOneAndUpdate(
    { organizationId: staff.organizationId },
    { $set: fields },
    { new: true, runValidators: true }
  );
  await audit(req, "updated", "OrganizationSettings", String(result?._id));
  return result;
}
export async function guardGrant(req: Request, permissions: Permission[]) {
  const staff = actor(req);
  if (staff.isSuperAdmin) return;
  const current = await resolvePermissions(staff);
  for (const entry of permissions) {
    const own = current[entry.module];
    if (
      !permits(own.level, entry.level) ||
      (own.scope === "own" && entry.scope === "all" && entry.level !== "none")
    )
      throw new ForbiddenError("Cannot grant access beyond your own permissions");
  }
}
export async function listRoles(req: Request) {
  const organizationId = actor(req).organizationId;
  const roles = await Role.find({ organizationId }).lean();
  return Promise.all(
    roles.map(async (role) => ({
      ...role,
      memberCount: await StaffMember.countDocuments({
        organizationId,
        roleId: role._id,
        accountStatus: { $ne: "deactivated" },
        deletedAt: null,
      }),
    }))
  );
}
export async function saveRole(req: Request) {
  const organizationId = actor(req).organizationId;
  if (req.body.permissions) await guardGrant(req, req.body.permissions);
  const row = req.params["id"]
    ? await Role.findOneAndUpdate(
        { _id: req.params["id"], organizationId },
        { $set: req.body },
        { new: true, runValidators: true }
      )
    : await Role.create({ ...req.body, organizationId });
  if (!row) throw new NotFoundError();
  await audit(req, req.params["id"] ? "updated" : "created", "Role", String(row._id));
  return row;
}
const defaults = PREFERENCE_DEFAULTS;
export async function preferences(req: Request, write = false) {
  const staff = actor(req);
  const filter = { organizationId: staff.organizationId, staffId: staff._id };
  if (write) {
    const current = await NotificationPreference.findOne(filter).lean();
    const matrix = {
      ...defaults,
      ...current?.matrix,
      ...req.body.matrix,
      critical_alerts: defaults.critical_alerts,
    };
    const row = await NotificationPreference.findOneAndUpdate(
      filter,
      { $set: { matrix, quietHours: req.body.quietHours } },
      { upsert: true, new: true }
    );
    await audit(req, "updated", "NotificationPreference", String(row._id));
    return row;
  }
  return (
    (await NotificationPreference.findOne(filter).lean()) ?? {
      ...filter,
      matrix: defaults,
      quietHours: QUIET_HOURS_DEFAULT,
    }
  );
}
export async function saveRule(req: Request) {
  const organizationId = actor(req).organizationId;
  if (req.body.recipient && !(await Role.exists({ _id: req.body.recipient.id, organizationId })))
    throw new NotFoundError();
  const row = req.params["id"]
    ? await NotificationRule.findOneAndUpdate(
        { _id: req.params["id"], organizationId },
        { $set: req.body },
        { new: true, runValidators: true }
      )
    : await NotificationRule.create({ ...req.body, organizationId });
  if (!row) throw new NotFoundError();
  await audit(req, req.params["id"] ? "updated" : "created", "NotificationRule", String(row._id));
  return row;
}
export async function listAudit(req: Request) {
  const query = auditQuery.parse(req.query);
  const filter: FilterQuery<unknown> = { organizationId: actor(req).organizationId };
  for (const key of ["actorId", "memberId", "action"] as const)
    if (query[key]) filter[key] = query[key];
  if (query.from || query.to)
    filter["occurredAt"] = {
      ...(query.from ? { $gte: new Date(query.from) } : {}),
      ...(query.to ? { $lt: new Date(query.to) } : {}),
    };
  if (query.cursor) filter["_id"] = { $lt: query.cursor };
  const items = await AuditEvent.find(filter)
    .sort({ _id: -1 })
    .limit(query.limit + 1)
    .lean();
  const more = items.length > query.limit;
  const visible = items.slice(0, query.limit);
  return { items: visible, nextCursor: more ? String(visible.at(-1)?._id) : null };
}
