import type { ClientSession } from "mongoose";
import { OrganizationSettings } from "../settings/settings.model.js";
import { PtoRequest, Shift } from "./schedule.model.js";

/**
 * Deactivation hand-off, run inside the deactivation transaction: shifts that have not
 * started become open (visible coverage gaps) and pending time off is denied. Worked and
 * running shifts stay assigned as history. Returns ids so the caller can audit each change.
 */
export async function releaseScheduleFor(
  organizationId: string,
  staffIds: string[],
  now: Date,
  session: ClientSession
) {
  // Same serialization point as shift and PTO writes.
  await OrganizationSettings.updateOne(
    { organizationId },
    { $inc: { scheduleRevision: 1 } },
    { upsert: true, session }
  );
  const owned = { organizationId, staffId: { $in: staffIds } };
  const shifts = await Shift.find({ ...owned, startAt: { $gt: now } })
    .select("_id")
    .session(session)
    .lean();
  const pto = await PtoRequest.find({ ...owned, status: "pending" })
    .select("_id")
    .session(session)
    .lean();
  await Shift.updateMany(
    { _id: { $in: shifts.map((s) => s._id) } },
    { $set: { staffId: null } },
    { session }
  );
  await PtoRequest.updateMany(
    { _id: { $in: pto.map((p) => p._id) } },
    { $set: { status: "denied", reason: "Staff member deactivated", decidedAt: now } },
    { session }
  );
  return { shiftIds: shifts.map((s) => String(s._id)), ptoIds: pto.map((p) => String(p._id)) };
}
