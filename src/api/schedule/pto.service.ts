import type { Request } from "express";
import type { ClientSession } from "mongoose";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import { OrganizationSettings } from "../settings/settings.model.js";
import { staffTarget } from "../staff/staff.service.js";
import { organizationToday } from "./flags.js";
import { PtoBalance, PtoRequest, Shift } from "./schedule.model.js";
import type { PTO_STATUSES } from "./schedule.schema.js";
import { daysByYear } from "./time.js";
import { scheduleAudit, schedulingTransaction } from "./transaction.js";

const DEFAULT_ALLOWANCE_DAYS = 15;
const DAY_POLICY = "inclusive_calendar_days";
const STAFF_FIELDS = "firstName lastName roleId photoUrl";
type PtoDocument = InstanceType<typeof PtoRequest>;
/** Balance for one staff/year. Allowance = per-staff override, else the live organization default. */
export async function balance(
  organizationId: string,
  staffId: string,
  year: number,
  session: ClientSession | null = null
) {
  // Sequential: parallel operations on one transaction session are unsupported.
  const settings = await OrganizationSettings.findOne({ organizationId }).session(session).lean();
  const row = await PtoBalance.findOne({ organizationId, staffId, year }).session(session).lean();
  const allowanceDays = row?.allowanceDays ?? settings?.ptoAllowanceDays ?? DEFAULT_ALLOWANCE_DAYS;
  const usedDays = row?.usedDays ?? 0;
  return { year, allowanceDays, usedDays, remainingDays: allowanceDays - usedDays };
}
/**
 * Appointment seam: W6 returns the provider's booked appointments inside the range.
 * Until appointments exist there are none, so approvers see an empty list.
 */
export function coverageConflicts(
  _organizationId: string,
  _staffId: string,
  _from: string,
  _toInclusive: string
): Promise<{ startAt: string; description: string }[]> {
  return Promise.resolve([]);
}
export async function listPto(req: Request, status?: (typeof PTO_STATUSES)[number]) {
  const organizationId = actor(req).organizationId;
  const items = await PtoRequest.find({
    organizationId,
    ...(req.permission?.scope === "own" ? { staffId: actor(req)._id } : {}),
    ...(status ? { status } : {}),
  })
    .sort({ startDate: 1, _id: 1 })
    .populate("staffId", STAFF_FIELDS)
    .lean();
  await audit(req, "viewed", "PtoRequests", organizationId);
  return items;
}
async function ptoTarget(req: Request) {
  const row = await PtoRequest.findOne({
    _id: req.params["id"],
    organizationId: actor(req).organizationId,
  });
  if (!row) throw new NotFoundError();
  await staffTarget(req, String(row.staffId));
  return row;
}
const shiftsDuring = (row: PtoDocument, session: ClientSession | null = null) =>
  Shift.find({
    organizationId: row.organizationId,
    staffId: row.staffId,
    date: { $gte: row.startDate, $lte: row.endDate },
    // Worked or running shifts are history; only shifts yet to start are released.
    startAt: { $gt: new Date() },
  }).session(session);
function balancesFor(row: PtoDocument) {
  return Promise.all(
    Object.entries(daysByYear(row.startDate, row.endDate)).map(async ([year, days]) => {
      const current = await balance(row.organizationId, String(row.staffId), Number(year));
      return {
        ...current,
        requestedDays: days,
        balanceBefore: current.remainingDays + (row.status === "approved" ? days : 0),
        balanceAfter: current.remainingDays - (row.status === "pending" ? days : 0),
      };
    })
  );
}
export async function ptoDetail(req: Request) {
  const row = await ptoTarget(req);
  const [balances, affectedShifts, conflicts] = await Promise.all([
    balancesFor(row),
    shiftsDuring(row).sort({ startAt: 1 }).lean(),
    coverageConflicts(row.organizationId, String(row.staffId), row.startDate, row.endDate),
  ]);
  await row.populate("staffId", STAFF_FIELDS);
  await audit(req, "viewed", "PtoRequest", String(row._id));
  return {
    ...row.toObject(),
    balances,
    balanceBefore: balances.reduce((sum, b) => sum + b.balanceBefore, 0),
    balanceAfter: balances.reduce((sum, b) => sum + b.balanceAfter, 0),
    affectedShifts,
    coverageConflicts: conflicts,
    dayCountingPolicy: DAY_POLICY,
  };
}
/** Self-service: a signed-in staff member requests time off for themselves only. */
export async function createPto(req: Request) {
  const { startDate, endDate } = req.body as { startDate: string; endDate: string };
  if (startDate < (await organizationToday(actor(req).organizationId)))
    throw new ValidationError("Time off cannot start before today", "PTO_IN_PAST");
  return schedulingTransaction(req, async (session) => {
    const staff = actor(req);
    const overlap = await PtoRequest.exists({
      organizationId: staff.organizationId,
      staffId: staff._id,
      status: { $in: ["pending", "approved"] },
      startDate: { $lte: endDate },
      endDate: { $gte: startDate },
    }).session(session);
    if (overlap)
      throw new ConflictError(
        "Time off overlaps a pending or approved request",
        undefined,
        "PTO_OVERLAP"
      );
    const days = Object.values(daysByYear(startDate, endDate)).reduce((sum, n) => sum + n, 0);
    const row = await new PtoRequest({
      ...req.body,
      organizationId: staff.organizationId,
      staffId: staff._id,
      days,
    }).save({ session });
    await scheduleAudit(req, session, "created", "PtoRequest", String(row._id));
    return row;
  });
}
async function deduct(row: PtoDocument, session: ClientSession) {
  const perYear = Object.entries(daysByYear(row.startDate, row.endDate));
  for (const [year, days] of perYear) {
    const current = await balance(row.organizationId, String(row.staffId), Number(year), session);
    if (current.remainingDays < days)
      throw new ConflictError("Insufficient time-off balance", undefined, "PTO_BALANCE_EXCEEDED");
  }
  for (const [year, days] of perYear)
    await PtoBalance.updateOne(
      { organizationId: row.organizationId, staffId: row.staffId, year: Number(year) },
      { $inc: { usedDays: days } },
      { upsert: true, session }
    );
}
/** Approved leave keeps coverage explicit: the staff member's shifts in range become open. */
async function releaseShifts(req: Request, row: PtoDocument, session: ClientSession) {
  const shifts = await shiftsDuring(row, session).select("_id").lean();
  if (!shifts.length) return;
  await Shift.updateMany(
    { _id: { $in: shifts.map((s) => s._id) } },
    { $set: { staffId: null } },
    { session }
  );
  for (const shift of shifts)
    await scheduleAudit(req, session, "unassigned_for_pto", "Shift", String(shift._id));
}
export async function decidePto(req: Request, approve: boolean) {
  const initial = await ptoTarget(req);
  if (String(initial.staffId) === String(actor(req)._id))
    throw new ForbiddenError("You cannot decide your own time-off request", "PTO_SELF_DECISION");
  return schedulingTransaction(req, async (session) => {
    const row = await PtoRequest.findById(initial._id).session(session);
    if (row?.status !== "pending")
      throw new ConflictError("This request was already decided", undefined, "PTO_ALREADY_DECIDED");
    if (approve) {
      await deduct(row, session);
      await releaseShifts(req, row, session);
    }
    row.set({
      status: approve ? "approved" : "denied",
      reason: (req.body as { reason?: string }).reason,
      decidedBy: actor(req)._id,
      decidedAt: new Date(),
    });
    await row.save({ session });
    const action = approve ? "approved" : "denied";
    await scheduleAudit(req, session, action, "PtoRequest", String(row._id));
    return row;
  });
}
export async function timeOff(req: Request, requestedYear?: number) {
  const target = await staffTarget(req);
  const today = await organizationToday(target.organizationId);
  const year = requestedYear ?? Number(today.slice(0, 4));
  const scope = { organizationId: target.organizationId, staffId: target._id };
  const [current, items, upcoming] = await Promise.all([
    balance(target.organizationId, String(target._id), year),
    PtoRequest.find({
      ...scope,
      startDate: { $lte: `${year}-12-31` },
      endDate: { $gte: `${year}-01-01` },
    })
      .sort({ startDate: 1, _id: 1 })
      .lean(),
    PtoRequest.findOne({ ...scope, status: "approved", endDate: { $gte: today } })
      .sort({ startDate: 1, _id: 1 })
      .lean(),
  ]);
  await audit(req, "viewed", "StaffTimeOff", String(target._id));
  return { balance: current, items, upcoming, dayCountingPolicy: DAY_POLICY };
}
