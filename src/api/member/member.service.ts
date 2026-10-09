import type { Request } from "express";
import mongoose, { type FilterQuery, type Types } from "mongoose";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../common/errors/AppError.js";
import { actor, escapedSearch, pagination } from "../../common/http.js";
import { appointmentOverview } from "../appointment/overview.service.js";
import { audit } from "../audit/audit.js";
import { Location } from "../location/location.model.js";
import { permits } from "../role/permission.js";
import { StaffMember } from "../staff/staff.model.js";
import { signedDownload, verifiedUpload } from "../upload/upload.service.js";
import {
  Member,
  type MemberData,
  type MemberDocument,
  MemberFlag,
  MemberNote,
} from "./member.model.js";
import type { MemberQuery } from "./member.schema.js";
import { isOwnScope, memberScope, memberTarget, permissionsOf } from "./member.scope.js";
import { brandLabels, holdMembership } from "./membership.service.js";

const LIST_FIELDS = "firstName lastName email phone status lastVisitAt photoUploadId archivedAt";
const FLAG_FILTER_CATEGORY = {
  on_waitlist: "waitlist",
  outstanding_balance: "outstanding_balance",
  flagged_for_review: "flagged_for_review",
} as const;
const SORTS: Record<string, Record<string, 1 | -1>> = {
  lastName: { lastName: 1, firstName: 1, _id: 1 },
  "-lastName": { lastName: -1, firstName: -1, _id: -1 },
  lastVisitAt: { lastVisitAt: 1, _id: 1 },
  "-lastVisitAt": { lastVisitAt: -1, _id: -1 },
  "-createdAt": { createdAt: -1, _id: -1 },
};
const emailTaken = () =>
  new ConflictError("A member already uses this email", undefined, "MEMBER_EMAIL_EXISTS");
const isDuplicate = (error: unknown) => (error as { code?: number }).code === 11000;
const alfredLink = (member: { alfredAccountId?: string | null }) => ({
  status: member.alfredAccountId ? "linked" : "unlinked",
  // No verified Alfred member-link contract is configured yet (inert seam).
  configured: false,
});

async function flagSummaries(organizationId: string, memberIds: Types.ObjectId[]) {
  const flags = await MemberFlag.find({
    organizationId,
    memberId: { $in: memberIds },
    resolvedAt: null,
  })
    .sort({ severity: -1, raisedAt: -1, _id: -1 })
    .select("memberId title severity")
    .lean();
  const summary = new Map<string, { count: number; primaryLabel: string }>();
  for (const flag of flags) {
    const key = String(flag.memberId);
    const current = summary.get(key);
    summary.set(key, {
      count: (current?.count ?? 0) + 1,
      primaryLabel: current?.primaryLabel ?? flag.title,
    });
  }
  return summary;
}

export async function listMembers(req: Request) {
  const query = req.query as unknown as MemberQuery;
  const filter: FilterQuery<MemberData> = { ...(await memberScope(req)), archivedAt: null };
  if (query.q) {
    const re = { $regex: escapedSearch(query.q), $options: "i" };
    filter.$or = [{ firstName: re }, { lastName: re }, { email: re }];
  }
  if (query.status?.length) filter.status = { $in: query.status };
  if (query.flags?.length) {
    const categories = query.flags.map(
      (flag: keyof typeof FLAG_FILTER_CATEGORY) => FLAG_FILTER_CATEGORY[flag]
    );
    const flagged = await MemberFlag.find({
      organizationId: filter["organizationId"],
      category: { $in: categories },
      resolvedAt: null,
    }).distinct("memberId");
    filter._id = { $in: flagged };
  }
  const [rows, total] = await Promise.all([
    Member.find(filter)
      .sort(SORTS[query.sort] ?? SORTS["lastName"])
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .select(LIST_FIELDS)
      .lean(),
    Member.countDocuments(filter),
  ]);
  const organizationId = actor(req).organizationId;
  const ids = rows.map((row) => row._id);
  const [flags, brands] = await Promise.all([
    flagSummaries(organizationId, ids),
    brandLabels(organizationId, ids),
  ]);
  await audit(req, "viewed", "MemberDirectory", organizationId);
  return {
    items: rows.map((row) => ({
      ...row,
      flagsSummary: flags.get(String(row._id)) ?? { count: 0, primaryLabel: null },
      brandLabel: brands.get(String(row._id)) ?? null,
    })),
    pagination: pagination(query.page, query.limit, total),
  };
}

export async function searchMembers(req: Request) {
  const re = { $regex: escapedSearch(String(req.query["q"])), $options: "i" };
  const rows = await Member.find({
    ...(await memberScope(req)),
    archivedAt: null,
    $or: [{ firstName: re }, { lastName: re }, { email: re }],
  })
    .sort({ lastName: 1, firstName: 1, _id: 1 })
    .limit(10)
    .select("firstName lastName")
    .lean();
  const brands = await brandLabels(
    actor(req).organizationId,
    rows.map((r) => r._id)
  );
  await audit(req, "searched", "MemberDirectory", actor(req).organizationId);
  return {
    items: rows.map((row) => ({
      _id: row._id,
      name: `${row.firstName} ${row.lastName}`,
      avatarUrl: null,
      brandLabel: brands.get(String(row._id)) ?? null,
    })),
    // Alfred platform member search is not configured yet.
    externalSearch: "unconfigured",
  };
}

async function assertReferences(
  organizationId: string,
  body: { homeLocationId?: string; assignedClinicianIds?: string[] }
) {
  if (body.homeLocationId && !(await Location.exists({ _id: body.homeLocationId, organizationId })))
    throw new NotFoundError("Location not found");
  const clinicians = body.assignedClinicianIds ?? [];
  if (clinicians.length) {
    const found = await StaffMember.countDocuments({
      _id: { $in: clinicians },
      organizationId,
      accountStatus: { $ne: "deactivated" },
    });
    if (found !== new Set(clinicians).size) throw new NotFoundError("Assigned clinician not found");
  }
}

async function photoUrl(member: Pick<MemberData, "photoUploadId" | "organizationId">) {
  if (!member.photoUploadId) return null;
  try {
    return (await signedDownload(String(member.photoUploadId), member.organizationId)).url;
  } catch (error) {
    // Unconfigured storage or a missing/unverified upload must not break the profile read.
    if (error instanceof AppError && [404, 503].includes(error.statusCode)) return null;
    throw error;
  }
}
async function presentMember(member: MemberDocument) {
  const brands = await brandLabels(member.organizationId, [member._id]);
  // Internal processor/locking fields never leave the API.
  const {
    processorCustomerId: Customer,
    membershipRevision: Revision,
    ...fields
  } = member.toObject();
  return {
    ...fields,
    photoUrl: await photoUrl(member),
    brandLabel: brands.get(String(member._id)) ?? null,
    alfredLink: alfredLink(member),
  };
}

export async function createMember(req: Request) {
  const staff = actor(req);
  const { memberships, photoUploadId, ...fields } = req.body;
  if (await isOwnScope(req)) fields.assignedClinicianIds = [String(staff._id)];
  await assertReferences(staff.organizationId, fields);
  if (await Member.exists({ organizationId: staff.organizationId, email: fields.email }))
    throw emailTaken();
  // Verify the photo before any write (storage unconfigured -> 503, nothing created).
  const photo = photoUploadId ? await verifiedUpload(req, "member_photo", photoUploadId) : null;
  try {
    const member = await mongoose.connection.transaction(async (session) => {
      const [row] = await Member.create(
        [
          {
            ...fields,
            organizationId: staff.organizationId,
            photoUploadId: photo?._id,
            createdById: staff._id,
          },
        ],
        { session }
      );
      if (!row) throw new AppError("Member was not created");
      await audit(req, "created", "Member", String(row._id), String(row._id), session);
      for (const membership of memberships) await holdMembership(req, row, membership, session);
      return row;
    });
    return presentMember(member);
  } catch (error) {
    if (isDuplicate(error)) throw emailTaken();
    throw error;
  }
}

export async function memberProfile(req: Request) {
  const member = await memberTarget(req);
  await audit(req, "viewed", "Member", String(member._id), String(member._id));
  return presentMember(member);
}

export async function updateMember(req: Request) {
  const member = await memberTarget(req, { write: true });
  const { photoUploadId, ...fields } = req.body;
  if (fields.assignedClinicianIds && (await isOwnScope(req)))
    throw new ForbiddenError("Own-scope staff cannot change member assignments");
  await assertReferences(member.organizationId, fields);
  if (
    fields.email &&
    fields.email !== member.email &&
    (await Member.exists({ organizationId: member.organizationId, email: fields.email }))
  )
    throw emailTaken();
  if (photoUploadId)
    fields.photoUploadId = (await verifiedUpload(req, "member_photo", photoUploadId))._id;
  member.set(fields);
  try {
    await member.save();
  } catch (error) {
    if (isDuplicate(error)) throw emailTaken();
    throw error;
  }
  await audit(req, "updated", "Member", String(member._id), String(member._id));
  return presentMember(member);
}

/** Archive (never delete). All ids must be in scope or nothing changes. */
export async function archiveMembers(req: Request) {
  const ids: string[] = [...new Set<string>(req.body.ids)];
  const scope = await memberScope(req);
  if ((await Member.countDocuments({ ...scope, _id: { $in: ids } })) !== ids.length)
    throw new NotFoundError("Member not found");
  let archived = 0;
  for (const id of ids) {
    // Conditional per-row claim: an already-archived row keeps its original stamp.
    const row = await Member.findOneAndUpdate(
      { ...scope, _id: id, archivedAt: null },
      { $set: { archivedAt: new Date(), archivedById: actor(req)._id } }
    );
    if (!row) continue;
    archived += 1;
    await audit(req, "archived", "Member", id, id);
  }
  return { archived };
}

export async function memberOverview(req: Request) {
  const member = await memberTarget(req);
  const permissions = await permissionsOf(req);
  const flags = await MemberFlag.find({
    organizationId: member.organizationId,
    memberId: member._id,
    resolvedAt: null,
  })
    .sort({ severity: -1, raisedAt: -1, _id: -1 })
    .limit(5)
    .lean();
  let notes: { newCount: number; items: unknown[] } | null = null;
  const reader = actor(req)._id;
  // Notes follow the CLINICAL_NOTES scope, which can be narrower than MEMBER_RECORDS.
  const notesInScope =
    permissions.CLINICAL_NOTES.scope === "all" ||
    member.assignedClinicianIds.some((id) => String(id) === String(reader));
  if (permits(permissions.CLINICAL_NOTES.level, "view") && notesInScope) {
    const filter = { organizationId: member.organizationId, memberId: member._id };
    const [items, newCount] = await Promise.all([
      MemberNote.find(filter).sort({ createdAt: -1, _id: -1 }).limit(3).lean(),
      MemberNote.countDocuments({ ...filter, readBy: { $ne: reader } }),
    ]);
    notes = { newCount, items };
  }
  const appointments = await appointmentOverview(req, member);
  await audit(req, "viewed", "MemberOverview", String(member._id), String(member._id));
  return {
    flags,
    notes,
    // Appointment blocks are null without APPOINTMENTS view. Clinical summaries
    // are served by the W8 clinical routes, so these three stay null.
    ...appointments,
    health: null,
    labs: null,
    dexa: null,
    devices: { status: "unconfigured", items: [] },
  };
}
