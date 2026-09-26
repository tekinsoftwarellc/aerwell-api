// Home dashboard widgets. Each returns null when the reader lacks the module
// permission (the widget is hidden, never a zero), and applies own scope the
// same way the module's own routes do. Days are local days in the org zone.
import type { Request } from "express";
import type { Types } from "mongoose";
import { actor } from "../../common/http.js";
import { Appointment, LIVE_STATUSES } from "../appointment/appointment.model.js";
import { dayStarts } from "../appointment/overview.service.js";
import { LabPanel, Scan } from "../clinical/records.model.js";
import { Member, MemberFlag, MemberNote } from "../member/member.model.js";
import { memberScope, permissionsOf } from "../member/member.scope.js";
import { permits } from "../role/permission.js";
import type { PermissionLevel, PermissionModule } from "../role/permission.types.js";
import { Role } from "../role/role.model.js";
import { organizationTimeZone } from "../schedule/flags.js";
import { PtoRequest, Shift } from "../schedule/schedule.model.js";
import { todayIn } from "../schedule/time.js";
import { Service } from "../service/service.model.js";
import { StaffMember } from "../staff/staff.model.js";

const HEAD = 3;
export const notConfigured = (reason: string) => ({ status: "not_configured" as const, reason });
type Name = { firstName: string; lastName: string; titlePrefix?: string | null };
export const fullName = (s: Name) =>
  [s.titlePrefix, s.firstName, s.lastName].filter(Boolean).join(" ");
const byId = <T extends { _id: unknown }>(rows: T[]) =>
  new Map(rows.map((r) => [String(r._id), r]));

export async function context(req: Request) {
  const staff = actor(req);
  const permissions = await permissionsOf(req);
  const tz = await organizationTimeZone(staff.organizationId);
  const date = (req.query["date"] as string | undefined) ?? todayIn(tz);
  const day = dayStarts(date, tz);
  const can = (module: PermissionModule, level: PermissionLevel = "view") =>
    permits(permissions[module].level, level);
  return { req, staff, permissions, tz, date, day, can, org: staff.organizationId };
}
export type Ctx = Awaited<ReturnType<typeof context>>;

/** memberId filter for own scope (MEMBER_RECORDS or any of `modules`); {} for all scope. */
async function memberFilter(ctx: Ctx, modules: PermissionModule[] = []) {
  const scope = await memberScope(ctx.req, modules);
  if (!("assignedClinicianIds" in scope)) return {};
  return { memberId: { $in: await Member.distinct("_id", scope) } };
}
export async function memberNames(ids: unknown[]) {
  const rows = await Member.find({ _id: { $in: ids } })
    .select("firstName lastName")
    .lean();
  return new Map(rows.map((m) => [String(m._id), `${m.firstName} ${m.lastName}`]));
}

export async function myAppointments(ctx: Ctx) {
  if (!ctx.can("APPOINTMENTS")) return null;
  return Appointment.countDocuments({
    organizationId: ctx.org,
    providerId: ctx.staff._id,
    status: { $in: LIVE_STATUSES },
    startAt: { $gte: ctx.day(0), $lt: ctx.day(1) },
  });
}

type Received = {
  _id: Types.ObjectId;
  memberId: unknown;
  createdAt: Date;
  panelType?: string | null;
};
const newest = (a: Received, b: Received) =>
  b.createdAt.getTime() - a.createdAt.getTime() || String(b._id).localeCompare(String(a._id));
export async function labsScans(ctx: Ctx) {
  if (!(ctx.can("MEMBER_RECORDS") && ctx.can("LABS_SCANS"))) return null;
  const filter = {
    organizationId: ctx.org,
    reviewStatus: "new",
    ...(await memberFilter(ctx, ["LABS_SCANS"])),
  };
  const head = { createdAt: -1, _id: -1 } as const;
  const [labs, scans, labRows, scanRows] = await Promise.all([
    LabPanel.countDocuments(filter),
    Scan.countDocuments(filter),
    LabPanel.find(filter).sort(head).limit(HEAD).select("memberId panelType createdAt").lean(),
    Scan.find(filter).sort(head).limit(HEAD).select("memberId createdAt").lean(),
  ]);
  const rows = [
    ...(labRows as Received[]).map((r) => ({
      ...r,
      kind: "lab",
      label: r.panelType || "Lab Panel",
    })),
    ...(scanRows as Received[]).map((r) => ({ ...r, kind: "scan", label: "DEXA Scan" })),
  ]
    .sort(newest)
    .slice(0, HEAD);
  const names = await memberNames(rows.map((r) => r.memberId));
  return {
    newCount: labs + scans,
    counts: { labs, scans },
    items: rows.map((r) => ({
      kind: r.kind,
      id: String(r._id),
      memberId: String(r.memberId),
      memberName: names.get(String(r.memberId)) ?? null,
      label: r.label,
      receivedAt: r.createdAt,
    })),
  };
}

/** Notes I have not read and did not write, grouped by author. */
export async function clinicalNotes(ctx: Ctx) {
  if (!(ctx.can("MEMBER_RECORDS") && ctx.can("CLINICAL_NOTES"))) return null;
  const groups: { _id: Types.ObjectId; count: number }[] = await MemberNote.aggregate([
    {
      $match: {
        organizationId: ctx.org,
        readBy: { $ne: ctx.staff._id },
        authorId: { $ne: ctx.staff._id },
        ...(await memberFilter(ctx, ["CLINICAL_NOTES"])),
      },
    },
    { $group: { _id: "$authorId", count: { $sum: 1 } } },
  ]);
  const authors = byId(
    await StaffMember.find({ _id: { $in: groups.map((g) => g._id) } })
      .select("firstName lastName titlePrefix")
      .lean()
  );
  const items = groups
    .map((g) => {
      const author = authors.get(String(g._id));
      return {
        authorId: String(g._id),
        authorName: author ? fullName(author) : "Staff member",
        count: g.count,
      };
    })
    .sort((a, b) => b.count - a.count || a.authorName.localeCompare(b.authorName));
  return { newCount: items.reduce((n, i) => n + i.count, 0), items: items.slice(0, HEAD) };
}

/** Open waitlist flags, distinct members per service. */
export async function waitlists(ctx: Ctx) {
  if (!ctx.can("MEMBER_RECORDS")) return null;
  const groups: { _id: Types.ObjectId | null; members: Types.ObjectId[] }[] =
    await MemberFlag.aggregate([
      {
        $match: {
          organizationId: ctx.org,
          category: "waitlist",
          resolvedAt: null,
          ...(await memberFilter(ctx)),
        },
      },
      { $group: { _id: "$relatedServiceId", members: { $addToSet: "$memberId" } } },
    ]);
  const services = byId(
    await Service.find({ _id: { $in: groups.map((g) => g._id).filter(Boolean) } })
      .select("title")
      .lean()
  );
  const items = groups
    .map((g) => ({
      serviceId: g._id ? String(g._id) : null,
      serviceName: services.get(String(g._id))?.title ?? "Unassigned service",
      memberCount: g.members.length,
    }))
    .sort((a, b) => b.memberCount - a.memberCount || a.serviceName.localeCompare(b.serviceName));
  const everyone = new Set(groups.flatMap((g) => g.members.map(String)));
  return { memberCount: everyone.size, items };
}

/** Staff with an assigned shift on the day; own scope sees only themselves. */
export async function staffToday(ctx: Ctx) {
  if (!ctx.can("STAFF_RECORDS")) return null;
  const own = ctx.permissions.STAFF_RECORDS.scope === "own";
  const shifts = await Shift.find({
    organizationId: ctx.org,
    date: ctx.date,
    staffId: own ? ctx.staff._id : { $ne: null },
  })
    .select("staffId startTime endTime")
    .lean();
  const spans = new Map<string, { startTime: string; endTime: string }>();
  for (const s of shifts) {
    const key = String(s.staffId);
    const span = spans.get(key);
    spans.set(key, {
      startTime: span && span.startTime < s.startTime ? span.startTime : s.startTime,
      endTime: span && span.endTime > s.endTime ? span.endTime : s.endTime,
    });
  }
  const staff = await StaffMember.find({ _id: { $in: [...spans.keys()] }, deletedAt: null })
    .select("firstName lastName titlePrefix photoUrl roleId")
    .lean();
  const roles = byId(
    await Role.find({ _id: { $in: staff.map((s) => s.roleId) } })
      .select("name")
      .lean()
  );
  const items = staff
    .map((s) => ({
      staffId: String(s._id),
      name: fullName(s),
      roleLabel: roles.get(String(s.roleId))?.name ?? null,
      photoUrl: s.photoUrl ?? null,
      ...(spans.get(String(s._id)) as { startTime: string; endTime: string }),
    }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name));
  return { count: items.length, items };
}

/** Pending time off an all-scope STAFF_RECORDS editor could decide (never their own). */
export async function pendingTimeOff(ctx: Ctx) {
  if (!(ctx.can("STAFF_RECORDS", "edit") && ctx.permissions.STAFF_RECORDS.scope === "all"))
    return 0;
  return PtoRequest.countDocuments({
    organizationId: ctx.org,
    status: "pending",
    staffId: { $ne: ctx.staff._id },
  });
}
