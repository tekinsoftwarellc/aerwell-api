// Appointment-derived blocks of the member overview (visit frequency, today's
// count, upcoming). Gated on APPOINTMENTS view; its own scope limits every
// block to the actor's own appointments. Days are local days in the org zone.
import type { Request } from "express";
import type { FilterQuery, Types } from "mongoose";
import { actor } from "../../common/http.js";
import type { MemberData } from "../member/member.model.js";
import { permissionsOf } from "../member/member.scope.js";
import { permits } from "../role/permission.js";
import { organizationTimeZone } from "../schedule/flags.js";
import { addDays, localInstant, todayIn } from "../schedule/time.js";
import {
  Appointment,
  type AppointmentData,
  LIVE_STATUSES,
  UPCOMING_STATUSES,
} from "./appointment.model.js";
import { VISIT_STATUSES, expand } from "./appointment.service.js";

type Row = AppointmentData & { _id: Types.ObjectId };
const WEEKS = 5;
const AVERAGE_WEEKS = 26; // ponytail: fixed 6-month window; add ?range=3mo|6mo|1yr with the range control
const UPCOMING_LIMIT = 3;
const oneDecimal = (n: number) => Math.round(n * 10) / 10;

function visitStats(starts: Date[], total: number, today: string, tz: string) {
  const midnight = (offset: number) => localInstant(addDays(today, offset), "00:00", tz);
  const between = (from: number, to: number) =>
    starts.filter((s) => s >= midnight(from) && s < midnight(to)).length;
  const last30Days = between(-29, 1);
  const previous30Days = between(-59, -29);
  const weekly = Array.from({ length: WEEKS }, (_, i) => {
    const end = 1 - (WEEKS - 1 - i) * 7;
    return { label: i === WEEKS - 1 ? "Now" : `Wk ${i + 1}`, count: between(end - 7, end) };
  });
  const recent = between(1 - AVERAGE_WEEKS * 7, 1);
  return {
    last30Days,
    previous30Days,
    trend:
      last30Days > previous30Days
        ? "increased"
        : last30Days < previous30Days
          ? "decreased"
          : "stable",
    weekly,
    avgPerWeek: oneDecimal(recent / AVERAGE_WEEKS),
    avgPerMonth: oneDecimal(recent / 6),
    total,
  };
}

export async function appointmentOverview(req: Request, member: MemberData & { _id: unknown }) {
  const { APPOINTMENTS } = await permissionsOf(req);
  if (!permits(APPOINTMENTS.level, "view"))
    return { visits: null, todayAppointment: null, appointments: null };
  const base: FilterQuery<AppointmentData> = {
    organizationId: member.organizationId,
    memberId: member._id,
    ...(APPOINTMENTS.scope === "own" ? { providerId: actor(req)._id } : {}),
  };
  const tz = await organizationTimeZone(member.organizationId);
  const now = new Date();
  const today = todayIn(tz, now);
  const midnight = (offset: number) => localInstant(addDays(today, offset), "00:00", tz);
  const visit = { ...base, status: { $in: VISIT_STATUSES } };
  const [recent, total, todayCount, upcoming] = await Promise.all([
    Appointment.find({
      ...visit,
      startAt: { $gte: midnight(1 - AVERAGE_WEEKS * 7), $lt: midnight(1) },
    })
      .select("startAt")
      .lean(),
    Appointment.countDocuments(visit),
    Appointment.countDocuments({
      ...base,
      status: { $in: LIVE_STATUSES },
      startAt: { $gte: midnight(0), $lt: midnight(1) },
    }),
    Appointment.find({ ...base, status: { $in: UPCOMING_STATUSES }, startAt: { $gte: now } })
      .sort({ startAt: 1, _id: 1 })
      .limit(UPCOMING_LIMIT)
      .lean(),
  ]);
  const items = await expand(upcoming as Row[]);
  const first = items[0];
  return {
    visits: visitStats(
      recent.map((r) => r.startAt),
      total,
      today,
      tz
    ),
    todayAppointment: first && new Date(first.startAt) < midnight(1) ? first : null,
    appointments: { todayCount, upcoming: items },
  };
}
