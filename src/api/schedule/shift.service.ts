import type { Request } from "express";
import type { ClientSession, FilterQuery } from "mongoose";
import { ConflictError, NotFoundError } from "../../common/errors/AppError.js";
import { actor, escapedSearch } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import { Location } from "../location/location.model.js";
import { Role } from "../role/role.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { staffTarget } from "../staff/staff.service.js";
import { PtoRequest, Shift } from "./schedule.model.js";
import { type ScheduleQuery, type ShiftInput, shiftBody } from "./schedule.schema.js";
import { dateRange, localInstant } from "./time.js";
import { scheduleAudit, schedulingTransaction } from "./transaction.js";

const isOwnScope = (req: Request) => req.permission?.scope === "own";
/** Staff visible to the actor, optionally narrowed by name and primary role. */
export function staffFilter(req: Request, narrow: { q?: string; roleIds?: string[] } = {}) {
  const filter: FilterQuery<unknown> = {
    organizationId: actor(req).organizationId,
    deletedAt: null,
  };
  if (isOwnScope(req)) filter["_id"] = actor(req)._id;
  if (narrow.q) {
    const re = { $regex: escapedSearch(narrow.q), $options: "i" };
    filter["$or"] = [{ firstName: re }, { lastName: re }];
  }
  if (narrow.roleIds?.length) filter["roleId"] = { $in: narrow.roleIds };
  return filter;
}
export async function listShifts(req: Request, query: ScheduleQuery) {
  const organizationId = actor(req).organizationId;
  if (query.staffId) await staffTarget(req, query.staffId);
  const range = dateRange(query.date, query.view);
  const filter: FilterQuery<unknown> = {
    organizationId,
    date: { $gte: range.from, $lt: range.to },
  };
  if (query.staffId) filter["staffId"] = query.staffId;
  else if (query.q || query.roleIds?.length || isOwnScope(req))
    filter["staffId"] = { $in: await StaffMember.find(staffFilter(req, query)).distinct("_id") };
  const items = await Shift.find(filter)
    .sort({ startAt: 1, _id: 1 })
    .populate("staffId", "firstName lastName roleId accountStatus")
    .populate("positionRoleId", "name shortCode color department")
    .lean();
  await audit(req, "viewed", "StaffSchedule", query.staffId ?? organizationId);
  const totalMs = items.reduce((sum, row) => sum + row.endAt.getTime() - row.startAt.getTime(), 0);
  return { items, view: query.view, ...range, totalHours: totalMs / 3600000 };
}
async function resolveAssignment(req: Request, input: ShiftInput) {
  const organizationId = actor(req).organizationId;
  if (input.staffId) {
    const target = await staffTarget(req, input.staffId);
    if (target.accountStatus === "deactivated")
      throw new ConflictError(
        "Deactivated staff cannot be scheduled",
        undefined,
        "SHIFT_STAFF_INACTIVE"
      );
  } else if (isOwnScope(req)) throw new NotFoundError();
  const [location, role] = await Promise.all([
    Location.findOne({ _id: input.locationId, organizationId }).lean(),
    Role.exists({ _id: input.positionRoleId, organizationId }),
  ]);
  if (!(location && role)) throw new NotFoundError("Location or role not found");
  const timeZone = location.timeZone ?? "America/Los_Angeles";
  return {
    organizationId,
    ...input,
    staffId: input.staffId ?? null,
    timeZone,
    startAt: localInstant(input.date, input.startTime, timeZone),
    endAt: localInstant(input.date, input.endTime, timeZone),
  };
}
type Assignment = Awaited<ReturnType<typeof resolveAssignment>>;
async function assertNoConflict(input: Assignment, session: ClientSession, id?: string) {
  if (!input.staffId) return;
  const base = { organizationId: input.organizationId, staffId: input.staffId };
  const overlap = await Shift.exists({
    ...base,
    ...(id ? { _id: { $ne: id } } : {}),
    startAt: { $lt: input.endAt },
    endAt: { $gt: input.startAt },
  }).session(session);
  if (overlap)
    throw new ConflictError("Shift overlaps an existing shift", undefined, "SHIFT_OVERLAP");
  const onLeave = await PtoRequest.exists({
    ...base,
    status: "approved",
    startDate: { $lte: input.date },
    endDate: { $gte: input.date },
  }).session(session);
  if (onLeave)
    throw new ConflictError("Staff member has approved time off", undefined, "SHIFT_DURING_PTO");
}
const editable = (row: InstanceType<typeof Shift>) => ({
  staffId: row.staffId ? String(row.staffId) : null,
  date: row.date,
  startTime: row.startTime,
  endTime: row.endTime,
  positionRoleId: String(row.positionRoleId),
  locationId: String(row.locationId),
  ...(row.stationName ? { stationName: row.stationName } : {}),
});
/** Loads a shift the actor may change: own scope never reaches open or other staff's shifts. */
async function ownedShift(req: Request, session: ClientSession) {
  const row = await Shift.findOne({
    _id: req.params["id"],
    organizationId: actor(req).organizationId,
  }).session(session);
  if (!row) throw new NotFoundError();
  if (row.staffId) await staffTarget(req, String(row.staffId));
  else if (isOwnScope(req)) throw new NotFoundError();
  return row;
}
export function createShift(req: Request) {
  return schedulingTransaction(req, async (session) => {
    const input = await resolveAssignment(req, req.body as ShiftInput);
    await assertNoConflict(input, session);
    const row = await new Shift(input).save({ session });
    await scheduleAudit(req, session, "created", "Shift", String(row._id));
    return row;
  });
}
export function updateShift(req: Request) {
  return schedulingTransaction(req, async (session) => {
    const row = await ownedShift(req, session);
    const merged = shiftBody.parse({ ...editable(row), ...req.body });
    const input = await resolveAssignment(req, merged);
    await assertNoConflict(input, session, String(row._id));
    row.set(input);
    await row.save({ session });
    await scheduleAudit(req, session, "updated", "Shift", String(row._id));
    return row;
  });
}
export function deleteShift(req: Request) {
  return schedulingTransaction(req, async (session) => {
    const row = await ownedShift(req, session);
    await row.deleteOne({ session });
    await scheduleAudit(req, session, "deleted", "Shift", String(row._id));
    return { deleted: true };
  });
}
/** Open (unassigned) shifts on a location date: the uncovered station windows. */
export function openShifts(req: Request, from: string, to: string) {
  if (isOwnScope(req)) return Promise.resolve([]);
  return Shift.find({
    organizationId: actor(req).organizationId,
    date: { $gte: from, $lt: to },
    staffId: null,
  })
    .sort({ startAt: 1, _id: 1 })
    .populate("positionRoleId", "name shortCode color department")
    .lean();
}
