import type { Request } from "express";
import type { FilterQuery } from "mongoose";
import { ConflictError, ForbiddenError, NotFoundError } from "../../common/errors/AppError.js";
import { actor, escapedSearch, pagination } from "../../common/http.js";
import { AuditEvent, audit } from "../audit/audit.js";
import { sendInvite } from "../invite/invite.service.js";
import { Location } from "../location/location.model.js";
import { permits, resolvePermissions } from "../role/permission.js";
import { Role } from "../role/role.model.js";
import { derivedFlagSets, flagsFor, isDerivedFlag, onDutyIds } from "../schedule/flags.js";
import { guardGrant } from "../settings/settings.service.js";
import { Certification, Employment, StaffFlag, StaffNote } from "./staff-details.model.js";
import { type StaffDocument, StaffMember } from "./staff.model.js";
import { staffQuery } from "./staff.schema.js";
export async function staffTarget(req: Request, id = req.params["id"]) {
  const staff = actor(req);
  const permissions = req.permissions ?? (await resolvePermissions(staff));
  const allowed = permissions.STAFF_RECORDS;
  if (!permits(allowed.level, "view")) throw new ForbiddenError();
  if (allowed.scope === "own" && id !== String(staff._id)) throw new NotFoundError();
  const target = await StaffMember.findOne({
    _id: id,
    organizationId: staff.organizationId,
    deletedAt: null,
  });
  if (!target) throw new NotFoundError();
  return target;
}
async function matchesFlags(organizationId: string, flags: string[]) {
  const ids: string[] = [];
  if (flags.includes("custom"))
    ids.push(
      ...(await StaffFlag.find({ organizationId, resolvedAt: null }).distinct("staffId")).map(
        String
      )
    );
  const derived = flags.filter(isDerivedFlag);
  if (derived.length)
    for (const members of (await derivedFlagSets(organizationId, derived)).values())
      ids.push(...members);
  return ids;
}
export async function directory(req: Request) {
  const staff = actor(req);
  const query = staffQuery.parse(req.query);
  const filter: FilterQuery<unknown> = { organizationId: staff.organizationId, deletedAt: null };
  if (query.q) {
    const re = { $regex: escapedSearch(query.q), $options: "i" };
    filter["$or"] = [{ firstName: re }, { lastName: re }, { email: re }];
  }
  if (query.roleIds?.length) filter["roleId"] = { $in: query.roleIds };
  const [flagSets, onDuty] = await Promise.all([
    derivedFlagSets(staff.organizationId),
    onDutyIds(staff.organizationId),
  ]);
  if (query.status?.length) {
    const conditions: FilterQuery<unknown>[] = [
      { accountStatus: { $in: query.status.filter((s) => s !== "on_duty") } },
    ];
    if (query.status.includes("on_duty"))
      conditions.push({ accountStatus: "active", _id: { $in: [...onDuty] } });
    filter["$and"] = [{ $or: conditions }];
  }
  if (query.flags?.length)
    filter["_id"] = { $in: await matchesFlags(staff.organizationId, query.flags) };
  if (req.permission?.scope === "own")
    filter["$and"] = [...(filter["$and"] ?? []), { _id: staff._id }];
  const [rows, total] = await Promise.all([
    StaffMember.find(filter)
      .sort({ roleId: 1, lastName: 1, _id: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    StaffMember.countDocuments(filter),
  ]);
  const items = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      role: await Role.findOne({ _id: row.roleId, organizationId: staff.organizationId })
        .select("name shortCode color")
        .lean(),
      flags: [
        ...flagsFor(flagSets, String(row._id)),
        ...(await StaffFlag.find({
          staffId: row._id,
          organizationId: staff.organizationId,
          resolvedAt: null,
        })
          .select("label kind")
          .lean()),
      ],
      dutyStatus: row.accountStatus === "active" && onDuty.has(String(row._id)) ? "on_duty" : "off",
    }))
  );
  await audit(req, "viewed", "StaffDirectory", staff.organizationId);
  return { items, pagination: pagination(query.page, query.limit, total) };
}
export async function createStaff(req: Request) {
  const organizationId = actor(req).organizationId;
  const role = await Role.findOne({ _id: req.body.roleId, organizationId });
  if (!role) throw new NotFoundError();
  await guardGrant(req, role.permissions);
  if (req.body.locationId && !(await Location.exists({ _id: req.body.locationId, organizationId })))
    throw new NotFoundError();
  if (await StaffMember.exists({ organizationId, email: req.body.email }))
    throw new ConflictError(
      "A staff account already uses this email",
      undefined,
      "STAFF_EMAIL_EXISTS"
    );
  const { roleId, employmentType, startDate, locationId, licenses, ...personal } = req.body;
  let staff: StaffDocument;
  try {
    staff = await StaffMember.create({
      ...personal,
      roleId,
      homeLocationId: locationId,
      organizationId,
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      throw new ConflictError(
        "A staff account already uses this email",
        undefined,
        "STAFF_EMAIL_EXISTS"
      );
    throw error;
  }
  await Employment.create({
    organizationId,
    staffId: staff._id,
    employmentType,
    startDate,
    locationId,
  });
  for (const license of licenses)
    await Certification.create({ ...license, organizationId, staffId: staff._id });
  const invite = await sendInvite(staff);
  await audit(req, "created", "StaffMember", String(staff._id));
  return { staff, invite };
}
export async function staffProfile(req: Request) {
  const target = await staffTarget(req);
  await audit(req, "viewed", "StaffMember", String(target._id));
  const employmentDetails = await Employment.findOne({
    staffId: target._id,
    organizationId: target.organizationId,
  })
    .select("employmentType startDate")
    .lean();
  let photoUrl = target.photoUrl;
  if (target.photoUploadId) {
    const { signedDownload } = await import("../upload/upload.service.js");
    photoUrl = (await signedDownload(String(target.photoUploadId), target.organizationId)).url;
  }
  return {
    ...target.toObject(),
    photoUrl,
    employmentType: employmentDetails?.employmentType,
    startDate: employmentDetails?.startDate,
    role: await Role.findOne({ _id: target.roleId, organizationId: target.organizationId }).lean(),
    notes: await StaffNote.find({ staffId: target._id, organizationId: target.organizationId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    flags: [
      ...flagsFor(await derivedFlagSets(target.organizationId), String(target._id)),
      ...(await StaffFlag.find({
        staffId: target._id,
        organizationId: target.organizationId,
        resolvedAt: null,
      }).lean()),
    ],
  };
}
export async function updateStaff(req: Request) {
  const target = await staffTarget(req);
  target.set(req.body);
  await target.save();
  await audit(req, "updated", "StaffMember", String(target._id));
  return target;
}
export async function employment(req: Request, write = false) {
  const target = await staffTarget(req);
  const filter = { organizationId: target.organizationId, staffId: target._id };
  if (write) {
    if (
      req.body.locationId &&
      !(await Location.exists({ _id: req.body.locationId, organizationId: target.organizationId }))
    )
      throw new NotFoundError();
    await Employment.updateOne(filter, { $set: req.body }, { upsert: true, runValidators: true });
  }
  const row = await Employment.findOne(filter).lean();
  const permissions = await resolvePermissions(actor(req));
  const { compensation, ...visible } = row ?? {};
  const canRead =
    permits(permissions.BILLING.level, "view") &&
    (permissions.BILLING.scope === "all" || String(target._id) === String(actor(req)._id));
  await audit(req, write ? "updated" : "viewed", "Employment", String(target._id));
  return { ...visible, ...(canRead ? { compensation } : {}), compensationVisible: canRead };
}
export async function compensation(req: Request) {
  const target = await staffTarget(req);
  if (req.permission?.scope === "own" && String(target._id) !== String(actor(req)._id))
    throw new NotFoundError();
  await Employment.updateOne(
    { organizationId: target.organizationId, staffId: target._id },
    { $set: { compensation: req.body } },
    { upsert: true, runValidators: true }
  );
  await audit(req, "updated", "StaffCompensation", String(target._id));
  return { updated: true };
}
export async function permissions(req: Request, write = false) {
  const target = await staffTarget(req);
  if (write) {
    const role = await Role.findOne({
      _id: req.body.roleId,
      organizationId: target.organizationId,
    });
    if (!role) throw new NotFoundError();
    await guardGrant(req, role.permissions);
    await guardGrant(req, req.body.overrides);
    target.roleId = role._id;
    target.set("permissionOverrides", req.body.overrides);
    await target.save();
    await Employment.updateOne(
      { organizationId: target.organizationId, staffId: target._id },
      { $set: { employmentType: req.body.employmentType } },
      { upsert: true }
    );
    await audit(req, "updated", "StaffPermissions", String(target._id));
  }
  return {
    roleId: target.roleId,
    overrides: target.permissionOverrides,
    effective: await resolvePermissions(target),
  };
}
export async function certificates(req: Request, write = false) {
  const target = await staffTarget(req);
  const filter = { organizationId: target.organizationId, staffId: target._id };
  if (write) {
    const row = req.params["certId"]
      ? await Certification.findOneAndUpdate(
          { ...filter, _id: req.params["certId"] },
          { $set: req.body },
          { new: true, runValidators: true }
        )
      : await Certification.create({ ...filter, ...req.body });
    if (!row) throw new NotFoundError();
    await audit(req, "updated", "Certification", String(row._id));
  }
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);
  return (await Certification.find(filter).lean()).map((row) => ({
    ...row,
    status:
      row.expirationDate < today
        ? "expired"
        : row.expirationDate <= soon
          ? "expiring_soon"
          : "active",
  }));
}
export async function staffActivity(req: Request) {
  const target = await staffTarget(req);
  return AuditEvent.find({
    organizationId: target.organizationId,
    $or: [{ actorId: String(target._id) }, { targetId: String(target._id) }],
  })
    .sort({ occurredAt: -1 })
    .limit(Number(req.query["limit"] ?? 20))
    .lean();
}
