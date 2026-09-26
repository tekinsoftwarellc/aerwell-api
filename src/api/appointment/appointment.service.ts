// Calendar reads. Day boundaries are local midnights in the location's time
// zone (or the organization's), as exclusive [from, to) intervals.
import type { Request } from "express";
import type { FilterQuery, Types } from "mongoose";
import { ValidationError } from "../../common/errors/AppError.js";
import { actor, escapedSearch, pagination } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import { MembershipPlan } from "../catalog/catalog.model.js";
import { Location } from "../location/location.model.js";
import { Member } from "../member/member.model.js";
import { memberScope, memberTarget } from "../member/member.scope.js";
import { organizationTimeZone } from "../schedule/flags.js";
import { addDays, localInstant, todayIn } from "../schedule/time.js";
import { Service, ServiceCategory } from "../service/service.model.js";
import { StaffMember } from "../staff/staff.model.js";
import {
  Appointment,
  type AppointmentData,
  type AppointmentStatus,
  UPCOMING_STATUSES,
} from "./appointment.model.js";
import { providerName } from "./availability.service.js";
import { appointmentTarget } from "./booking.service.js";
import { TRANSITIONS, cancellationTerms } from "./lifecycle.service.js";

type Row = AppointmentData & { _id: Types.ObjectId };
const VISIT_STATUSES: AppointmentStatus[] = ["checked_in", "in_progress", "completed"];
const DEFAULT_HIDDEN: AppointmentStatus[] = ["cancelled"];
const MAX_RANGE_DAYS = 62;
const byId = <T extends { _id: unknown }>(rows: T[]) =>
  new Map(rows.map((r) => [String(r._id), r]));

async function zoneFor(organizationId: string, locationId?: string) {
  if (locationId) {
    const location = await Location.findOne({ _id: locationId, organizationId })
      .select("timeZone")
      .lean();
    if (location?.timeZone) return location.timeZone;
  }
  return organizationTimeZone(organizationId);
}
export function localRange(from: string, to: string, timeZone: string) {
  if (to <= from || to > addDays(from, MAX_RANGE_DAYS))
    throw new ValidationError(
      `Choose a range of 1 to ${MAX_RANGE_DAYS} days`,
      "INVALID_DATE_RANGE"
    );
  return { start: localInstant(from, "00:00", timeZone), end: localInstant(to, "00:00", timeZone) };
}
const monthRange = (month: string) => {
  const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
  return { from: `${month}-01`, to: next.toISOString().slice(0, 10) };
};

/** Member, service + category, provider and location for calendar rows (no N+1). */
export async function expand(rows: Row[]) {
  const [members, services, staff, locations] = await Promise.all([
    Member.find({ _id: { $in: rows.map((r) => r.memberId) } })
      .select("firstName lastName")
      .lean(),
    Service.find({ _id: { $in: rows.map((r) => r.serviceId) } })
      .select("title shortName categoryId")
      .lean(),
    StaffMember.find({ _id: { $in: rows.map((r) => r.providerId) } })
      .select("firstName lastName titlePrefix displayName")
      .lean(),
    Location.find({ _id: { $in: rows.map((r) => r.locationId) } })
      .select("name")
      .lean(),
  ]);
  const categories = byId(
    await ServiceCategory.find({ _id: { $in: services.map((s) => s.categoryId) } }).lean()
  );
  const [m, s, p, l] = [byId(members), byId(services), byId(staff), byId(locations)];
  return rows.map((row) => {
    const member = m.get(String(row.memberId));
    const service = s.get(String(row.serviceId));
    const category = categories.get(String(service?.categoryId));
    const provider = p.get(String(row.providerId));
    return {
      id: String(row._id),
      startAt: row.startAt,
      endAt: row.endAt,
      durationMinutes: row.durationMinutes,
      timeZone: row.timeZone,
      status: row.status,
      episodeId: row.episodeId ? String(row.episodeId) : null,
      deliveryMethod: row.deliveryMethod,
      member: member
        ? { id: String(member._id), name: `${member.firstName} ${member.lastName}` }
        : null,
      service: service
        ? {
            id: String(service._id),
            title: service.title,
            shortName: service.shortName ?? service.title,
            category: category
              ? { id: String(category._id), name: category.name, color: category.color }
              : null,
          }
        : null,
      provider: provider ? { id: String(provider._id), displayName: providerName(provider) } : null,
      location: l.get(String(row.locationId))
        ? { id: String(row.locationId), name: l.get(String(row.locationId))?.name }
        : null,
      amountDueCents: row.amountDueCents,
    };
  });
}

interface ListQuery {
  from: string;
  to: string;
  categoryId?: string[];
  serviceId?: string;
  providerId?: string;
  locationId?: string;
  memberId?: string;
  status?: AppointmentStatus[];
  q?: string;
  page: number;
  limit: number;
}
async function listFilter(req: Request, query: ListQuery) {
  const staff = actor(req);
  const tz = await zoneFor(staff.organizationId, query.locationId);
  const range = localRange(query.from, query.to, tz);
  const filter: FilterQuery<AppointmentData> = {
    organizationId: staff.organizationId,
    startAt: { $gte: range.start, $lt: range.end },
    status: query.status?.length ? { $in: query.status } : { $nin: DEFAULT_HIDDEN },
  };
  if (req.permission?.scope === "own") filter.providerId = staff._id;
  else if (query.providerId) filter.providerId = query.providerId;
  if (query.categoryId?.length) filter.categoryId = { $in: query.categoryId };
  if (query.serviceId) filter.serviceId = query.serviceId;
  if (query.locationId) filter.locationId = query.locationId;
  const memberFilter: FilterQuery<unknown> = { ...(await memberScope(req)) };
  if (query.q)
    memberFilter.$or = ["firstName", "lastName"].map((field) => ({
      [field]: { $regex: escapedSearch(query.q ?? ""), $options: "i" },
    }));
  if (query.memberId) memberFilter._id = query.memberId;
  if (query.q || query.memberId || "assignedClinicianIds" in memberFilter)
    filter.memberId = { $in: await Member.find(memberFilter).distinct("_id") };
  return { filter, tz };
}

export async function listAppointments(req: Request) {
  const query = req.query as unknown as ListQuery;
  const { filter, tz } = await listFilter(req, query);
  const [rows, total] = await Promise.all([
    Appointment.find(filter)
      .sort({ startAt: 1, _id: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    Appointment.countDocuments(filter),
  ]);
  await audit(req, "viewed", "Appointments", actor(req).organizationId);
  return {
    timeZone: tz,
    items: await expand(rows as Row[]),
    pagination: pagination(query.page, query.limit, total),
  };
}

/** Per local day counts (and the total) for 4-day headers and the mini month calendar. */
export async function appointmentSummary(req: Request) {
  const raw = req.query as unknown as Partial<ListQuery> & { month?: string };
  const bounds = raw.month ? monthRange(raw.month) : { from: raw.from ?? "", to: raw.to ?? "" };
  const { filter, tz } = await listFilter(req, { ...raw, ...bounds, page: 1, limit: 1 });
  const rows = await Appointment.find(filter).select("startAt").lean();
  const counts = new Map<string, number>();
  for (const row of rows) {
    const date = todayIn(tz, row.startAt);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const days: { date: string; count: number }[] = [];
  for (let date = bounds.from; date < bounds.to; date = addDays(date, 1))
    days.push({ date, count: counts.get(date) ?? 0 });
  await audit(req, "viewed", "AppointmentSummary", actor(req).organizationId);
  return { timeZone: tz, from: bounds.from, to: bounds.to, total: rows.length, days };
}

async function visitsThisMonth(row: Row) {
  const month = todayIn(row.timeZone, row.startAt).slice(0, 7);
  const { from, to } = monthRange(month);
  return Appointment.countDocuments({
    organizationId: row.organizationId,
    memberId: row.memberId,
    status: { $in: VISIT_STATUSES },
    startAt: {
      $gte: localInstant(from, "00:00", row.timeZone),
      $lt: localInstant(to, "00:00", row.timeZone),
    },
  });
}

export async function appointmentDetail(req: Request) {
  const doc = await appointmentTarget(req);
  const row = doc.toObject() as Row;
  const price = row.price as { selection?: { planId?: string | null } };
  const [[base], visits, plan, terms] = await Promise.all([
    expand([row]),
    visitsThisMonth(row),
    price.selection?.planId
      ? MembershipPlan.findById(price.selection.planId).select("name brand").lean()
      : null,
    cancellationTerms(doc),
  ]);
  await audit(req, "viewed", "Appointment", String(row._id), String(row.memberId));
  return {
    ...base,
    reason: row.reason ?? null,
    reasonDetail: row.reasonDetail ?? null,
    memberNote: row.memberNote ?? null,
    bookingSource: row.bookingSource,
    bookedAt: row.bookedAt,
    modality: row.modality,
    membership: plan ? { planId: String(plan._id), name: plan.name, brand: plan.brand } : null,
    visitsThisMonth: visits,
    price: row.price,
    paymentStatus: row.paymentStatus,
    cancellation: row.cancellation ?? null,
    cancellationPreview: row.status === "cancelled" ? null : terms,
    statusHistory: row.statusHistory,
    allowedTransitions: TRANSITIONS[row.status as AppointmentStatus] ?? [],
  };
}

/** GET /members/:id/appointments?scope=upcoming|past|all&q */
export async function memberAppointments(req: Request) {
  const member = await memberTarget(req);
  const { scope, q, page, limit } = req.query as unknown as {
    scope: "upcoming" | "past" | "all";
    q?: string;
    page: number;
    limit: number;
  };
  const now = new Date();
  const filter: FilterQuery<AppointmentData> = {
    organizationId: member.organizationId,
    memberId: member._id,
    ...(req.permission?.scope === "own" ? { providerId: actor(req)._id } : {}),
  };
  if (scope === "upcoming")
    Object.assign(filter, { startAt: { $gte: now }, status: { $in: UPCOMING_STATUSES } });
  if (scope === "past")
    filter.$or = [{ startAt: { $lt: now } }, { status: { $nin: UPCOMING_STATUSES } }];
  if (q) {
    const services = await Service.find({
      organizationId: member.organizationId,
      title: { $regex: escapedSearch(q), $options: "i" },
    }).distinct("_id");
    filter.serviceId = { $in: services };
  }
  const [rows, total] = await Promise.all([
    Appointment.find(filter)
      .sort({ startAt: scope === "upcoming" ? 1 : -1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Appointment.countDocuments(filter),
  ]);
  await audit(req, "viewed", "MemberAppointments", String(member._id), String(member._id));
  return { items: await expand(rows as Row[]), pagination: pagination(page, limit, total) };
}
