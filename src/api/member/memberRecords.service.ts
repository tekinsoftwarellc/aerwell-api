import type { Request } from "express";
import { ConflictError, NotFoundError } from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { Appointment } from "../appointment/appointment.model.js";
import { audit } from "../audit/audit.js";
import { Service } from "../service/service.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { MemberFlag, MemberNote, ViewPreference } from "./member.model.js";
import { memberTarget } from "./member.scope.js";

const NOTES = { modules: ["CLINICAL_NOTES" as const] };
const byMember = (member: { organizationId: string; _id: unknown }) => ({
  organizationId: member.organizationId,
  memberId: member._id,
});

export async function listFlags(req: Request) {
  const member = await memberTarget(req);
  const state = req.query["state"];
  const resolved =
    state === "active"
      ? { resolvedAt: null }
      : state === "resolved"
        ? { resolvedAt: { $ne: null } }
        : {};
  const rows = await MemberFlag.find({ ...byMember(member), ...resolved })
    .sort({ raisedAt: -1, _id: -1 })
    .lean();
  await audit(req, "viewed", "MemberFlags", String(member._id), String(member._id));
  return rows;
}
export async function createFlag(req: Request) {
  const member = await memberTarget(req, { write: true });
  if (
    req.body.relatedServiceId &&
    !(await Service.exists({
      _id: req.body.relatedServiceId,
      organizationId: member.organizationId,
    }))
  )
    throw new NotFoundError("Service not found");
  const row = await MemberFlag.create({
    ...req.body,
    ...byMember(member),
    raisedBy: String(actor(req)._id),
  });
  await audit(req, "created", "MemberFlag", String(row._id), String(member._id));
  return row;
}
export async function resolveFlag(req: Request) {
  const member = await memberTarget(req, { write: true });
  const filter = { ...byMember(member), _id: req.params["flagId"] };
  // Conditional claim: only an unresolved flag can be resolved, exactly once.
  const row = await MemberFlag.findOneAndUpdate(
    { ...filter, resolvedAt: null },
    { $set: { resolvedAt: new Date(), resolvedById: actor(req)._id } },
    { new: true }
  );
  if (!row) {
    if (await MemberFlag.exists(filter))
      throw new ConflictError("Flag is already resolved", undefined, "FLAG_ALREADY_RESOLVED");
    throw new NotFoundError("Flag not found");
  }
  await audit(req, "resolved", "MemberFlag", String(row._id), String(member._id));
  return row;
}

export async function listNotes(req: Request) {
  const member = await memberTarget(req, NOTES);
  const reader = String(actor(req)._id);
  const appointmentId = req.query["appointmentId"];
  const rows = await MemberNote.find({
    ...byMember(member),
    ...(appointmentId ? { appointmentId } : {}),
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(200)
    .lean();
  const authors = await StaffMember.find({ _id: { $in: rows.map((r) => r.authorId) } })
    .select("firstName lastName titlePrefix")
    .lean();
  const authorOf = new Map(authors.map((a) => [String(a._id), a]));
  const items = rows.map(({ readBy, ...row }) => {
    const author = authorOf.get(String(row.authorId));
    return {
      ...row,
      author: author
        ? {
            name: `${author.firstName} ${author.lastName}`,
            titlePrefix: author.titlePrefix ?? null,
          }
        : null,
      isNew: !readBy.some((id) => String(id) === reader),
    };
  });
  await audit(req, "viewed", "MemberNotes", String(member._id), String(member._id));
  return { newCount: items.filter((n) => n.isNew).length, items };
}
export async function createNote(req: Request) {
  const member = await memberTarget(req, { ...NOTES, write: true });
  // A visit note must belong to one of THIS member's appointments.
  if (
    req.body.appointmentId &&
    !(await Appointment.exists({ _id: req.body.appointmentId, ...byMember(member) }))
  )
    throw new NotFoundError("Appointment not found");
  const author = actor(req)._id;
  const row = await MemberNote.create({
    ...req.body,
    ...byMember(member),
    authorId: author,
    readBy: [author],
  });
  await audit(req, "created", "MemberNote", String(row._id), String(member._id));
  const { readBy: ReadBy, ...note } = row.toObject();
  return note;
}
export async function markNotesRead(req: Request) {
  const member = await memberTarget(req, NOTES);
  const ids: string[] | undefined = req.body.noteIds;
  const result = await MemberNote.updateMany(
    { ...byMember(member), ...(ids ? { _id: { $in: ids } } : {}) },
    { $addToSet: { readBy: actor(req)._id } }
  );
  await audit(req, "read", "MemberNotes", String(member._id), String(member._id));
  return { updated: result.modifiedCount };
}

// Figma defaults: the in-visit 1-column set, and the two-column profile overview.
const DEFAULT_VIEWS: Record<string, { layout: number; columns: string[][] }> = {
  member_appointment: {
    layout: 1,
    columns: [["appointment", "health", "labs", "scans", "meds", "supps"]],
  },
  member_profile: {
    layout: 2,
    columns: [
      ["alfred", "health", "labs", "scans", "appointment"],
      ["notes", "membership"],
    ],
  },
};
export async function getViewPreference(req: Request) {
  const staff = actor(req);
  const row = await ViewPreference.findOne({
    organizationId: staff.organizationId,
    staffId: staff._id,
    context: req.params["context"],
  }).lean();
  return row
    ? { context: row.context, layout: row.layout, columns: row.columns, isDefault: false }
    : {
        context: req.params["context"],
        ...DEFAULT_VIEWS[String(req.params["context"])],
        isDefault: true,
      };
}
export async function putViewPreference(req: Request) {
  const staff = actor(req);
  const row = await ViewPreference.findOneAndUpdate(
    { organizationId: staff.organizationId, staffId: staff._id, context: req.params["context"] },
    { $set: { layout: req.body.layout, columns: req.body.columns } },
    { upsert: true, new: true, runValidators: true }
  ).lean();
  return { context: row?.context, layout: row?.layout, columns: row?.columns, isDefault: false };
}
