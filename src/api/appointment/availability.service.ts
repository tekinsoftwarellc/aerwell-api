// Bookable slots = provider shifts at the location, clipped to the location's
// business hours, minus approved PTO days, minus the provider's live
// appointments (group services share a slot up to capacityMax). All instants
// are UTC; local dates/hours are resolved in Location.timeZone.
import type { Request } from "express";
import type { ClientSession, Types } from "mongoose";
import { NotFoundError, ValidationError } from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import { STANDARD_DELIVERY } from "../entitlement/entitlement.types.js";
import { Location } from "../location/location.model.js";
import { PtoRequest, Shift } from "../schedule/schedule.model.js";
import { addDays, localInstant, todayIn } from "../schedule/time.js";
import { Service } from "../service/service.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { Appointment, LIVE_STATUSES } from "./appointment.model.js";

export const SLOT_STEP_MINUTES = 15;
const MINUTE = 60_000;
const MAX_RANGE_DAYS = 14;
export interface Window {
  start: Date;
  end: Date;
}
export interface Busy {
  startAt: Date;
  endAt: Date;
  serviceId: string;
}
export interface SlotContext {
  durationMinutes: number;
  serviceId: string;
  capacityMax: number;
  windows: Window[];
  busy: Busy[];
  /** Live appointments of every service in this service's room or machine (empty when it has none). */
  roomBusy?: Busy[];
  now: Date;
}

/** Remaining capacity at `start`, or 0 when the slot cannot be booked. */
export function slotCapacity(ctx: SlotContext, start: Date): number {
  const end = new Date(start.getTime() + ctx.durationMinutes * MINUTE);
  if (start <= ctx.now) return 0;
  if (!ctx.windows.some((w) => w.start <= start && end <= w.end)) return 0;
  // One booking at a time per room or machine, whoever the provider is (a group session may share).
  const roomTaken = (ctx.roomBusy ?? []).some(
    (b) =>
      b.startAt < end &&
      b.endAt > start &&
      !(
        ctx.capacityMax > 1 &&
        b.serviceId === ctx.serviceId &&
        b.startAt.getTime() === start.getTime()
      )
  );
  if (roomTaken) return 0;
  const overlapping = ctx.busy.filter((b) => b.startAt < end && b.endAt > start);
  if (!overlapping.length) return ctx.capacityMax;
  // Only the same group session (same service, same start) can share a slot.
  const shared = overlapping.every(
    (b) => b.serviceId === ctx.serviceId && b.startAt.getTime() === start.getTime()
  );
  return shared ? Math.max(0, ctx.capacityMax - overlapping.length) : 0;
}

export function openSlots(ctx: SlotContext) {
  const slots: { startAt: Date; endAt: Date; remaining: number }[] = [];
  for (const window of ctx.windows)
    for (
      let t = window.start.getTime();
      t + ctx.durationMinutes * MINUTE <= window.end.getTime();
      t += SLOT_STEP_MINUTES * MINUTE
    ) {
      const remaining = slotCapacity(ctx, new Date(t));
      if (remaining > 0)
        slots.push({
          startAt: new Date(t),
          endAt: new Date(t + ctx.durationMinutes * MINUTE),
          remaining,
        });
    }
  return slots;
}

type LocationDoc = InstanceType<typeof Location>;
type ServiceDoc = InstanceType<typeof Service>;
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Shift ∩ business hours per shift, skipping days covered by approved PTO. */
async function providerWindows(
  location: LocationDoc,
  providerId: Types.ObjectId | string,
  range: Window,
  session: ClientSession | null
): Promise<Window[]> {
  const tz = location.timeZone ?? "America/Los_Angeles";
  const shifts = await Shift.find({
    organizationId: location.organizationId,
    staffId: providerId,
    locationId: location._id,
    startAt: { $lt: range.end },
    endAt: { $gt: range.start },
  })
    .session(session)
    .lean();
  const pto = await PtoRequest.find({
    organizationId: location.organizationId,
    staffId: providerId,
    status: "approved",
    startDate: { $lte: todayIn(tz, range.end) },
    endDate: { $gte: todayIn(tz, range.start) },
  })
    .session(session)
    .lean();
  const onLeave = (date: string) => pto.some((p) => p.startDate <= date && date <= p.endDate);
  return shifts.flatMap((shift) => {
    const hours = location.businessHours.find((h) => h.weekday === weekday(shift.date));
    if (onLeave(shift.date) || !hours || hours.closed) return [];
    const open = localInstant(shift.date, hours.open, tz);
    const close = localInstant(shift.date, hours.close, tz);
    const start = new Date(Math.max(shift.startAt.getTime(), open.getTime()));
    const end = new Date(Math.min(shift.endAt.getTime(), close.getTime()));
    return start < end ? [{ start, end }] : [];
  });
}

/** Live appointments in the same environment as `service`, for the room or machine check. */
async function roomOccupancy(
  service: ServiceDoc,
  range: Window,
  session: ClientSession | null,
  excludeAppointmentId?: unknown
) {
  const sharing = await Service.find({
    organizationId: service.organizationId,
    environmentId: service.environmentId,
  })
    .distinct("_id")
    .session(session);
  return Appointment.find({
    organizationId: service.organizationId,
    serviceId: { $in: sharing },
    // A delivery away from the clinic (mobile phlebotomy) never occupied the room.
    deliveryMethod: { $in: [STANDARD_DELIVERY, null] },
    status: { $in: LIVE_STATUSES },
    startAt: { $lt: range.end },
    endAt: { $gt: range.start },
    ...(excludeAppointmentId ? { _id: { $ne: excludeAppointmentId } } : {}),
  })
    .select("startAt endAt serviceId")
    .session(session)
    .lean();
}

export async function slotContext(
  location: LocationDoc,
  service: ServiceDoc,
  providerId: Types.ObjectId | string,
  range: Window,
  options: {
    session?: ClientSession | null;
    excludeAppointmentId?: unknown;
    now?: Date;
    /** A delivery away from the clinic (mobile phlebotomy) needs no room. */
    deliveryMethod?: string;
  } = {}
): Promise<SlotContext> {
  const session = options.session ?? null;
  const windows = await providerWindows(location, providerId, range, session);
  const busy = await Appointment.find({
    organizationId: location.organizationId,
    providerId,
    status: { $in: LIVE_STATUSES },
    startAt: { $lt: range.end },
    endAt: { $gt: range.start },
    ...(options.excludeAppointmentId ? { _id: { $ne: options.excludeAppointmentId } } : {}),
  })
    .select("startAt endAt serviceId")
    .session(session)
    .lean();
  const needsRoom =
    Boolean(service.environmentId) &&
    (options.deliveryMethod ?? STANDARD_DELIVERY) === STANDARD_DELIVERY;
  const room = needsRoom
    ? await roomOccupancy(service, range, session, options.excludeAppointmentId)
    : [];
  const toBusy = (b: { startAt: Date; endAt: Date; serviceId: unknown }) => ({
    startAt: b.startAt,
    endAt: b.endAt,
    serviceId: String(b.serviceId),
  });
  return {
    durationMinutes: service.durationMinutes,
    serviceId: String(service._id),
    capacityMax: service.capacityMax,
    windows,
    busy: busy.map(toBusy),
    roomBusy: room.map(toBusy),
    now: options.now ?? new Date(),
  };
}

/** Active staff who may deliver the service: assigned staff, else the team role, else providers. */
export async function eligibleProviders(
  service: ServiceDoc,
  providerId?: string,
  session: ClientSession | null = null
) {
  const filter: Record<string, unknown> = {
    organizationId: service.organizationId,
    accountStatus: "active",
    deletedAt: null,
  };
  if (service.assignedStaffIds.length) filter["_id"] = { $in: service.assignedStaffIds };
  else if (service.assignedTeamRoleId) filter["roleId"] = service.assignedTeamRoleId;
  else filter["isProvider"] = true;
  const staff = await StaffMember.find(filter)
    .select("firstName lastName titlePrefix displayName")
    .sort({ lastName: 1, _id: 1 })
    .session(session)
    .lean();
  return providerId ? staff.filter((s) => String(s._id) === providerId) : staff;
}

export const providerName = (s: {
  firstName: string;
  lastName: string;
  titlePrefix?: string | null;
  displayName?: string | null;
}) =>
  s.displayName ||
  (s.titlePrefix ? `${s.titlePrefix} ${s.lastName}` : `${s.firstName} ${s.lastName[0] ?? ""}.`);

export async function bookableService(organizationId: string, serviceId: string) {
  const service = await Service.findOne({ _id: serviceId, organizationId, deletedAt: null });
  if (!service) throw new NotFoundError("Service not found");
  return service;
}
export async function bookableLocation(organizationId: string, locationId: string) {
  const location = await Location.findOne({ _id: locationId, organizationId });
  if (!location) throw new NotFoundError("Location not found");
  return location;
}

/** GET /availability: open slots per eligible provider for local dates [from, to). */
export async function availability(req: Request) {
  const organizationId = actor(req).organizationId;
  const { serviceId, locationId, providerId, from, to, excludeAppointmentId } = req.query as {
    serviceId: string;
    locationId: string;
    providerId?: string;
    from: string;
    to?: string;
    excludeAppointmentId?: string;
  };
  const end = to ?? addDays(from, 1);
  if (end <= from || end > addDays(from, MAX_RANGE_DAYS))
    throw new ValidationError(
      `Choose a range of 1 to ${MAX_RANGE_DAYS} days`,
      "INVALID_DATE_RANGE"
    );
  const [service, location] = await Promise.all([
    bookableService(organizationId, serviceId),
    bookableLocation(organizationId, locationId),
  ]);
  const tz = location.timeZone ?? "America/Los_Angeles";
  const range = { start: localInstant(from, "00:00", tz), end: localInstant(end, "00:00", tz) };
  const scoped = req.permission?.scope === "own" ? String(actor(req)._id) : providerId;
  const providers = await eligibleProviders(service, scoped);
  const perProvider = await Promise.all(
    providers.map(async (provider) => {
      const ctx = await slotContext(location, service, provider._id, range, {
        excludeAppointmentId,
      });
      return openSlots(ctx).map((slot) => ({
        ...slot,
        providerId: String(provider._id),
        providerName: providerName(provider),
      }));
    })
  );
  await audit(req, "viewed", "Availability", serviceId);
  return {
    timeZone: tz,
    from,
    to: end,
    durationMinutes: service.durationMinutes,
    stepMinutes: SLOT_STEP_MINUTES,
    slots: perProvider
      .flat()
      .sort(
        (a, b) =>
          a.startAt.getTime() - b.startAt.getTime() || a.providerName.localeCompare(b.providerName)
      ),
  };
}
