import type { AppointmentData } from "../appointment/appointment.model.js";
import { providerName } from "../appointment/availability.service.js";
import { Location } from "../location/location.model.js";
import { Role } from "../role/role.model.js";
import { Service } from "../service/service.model.js";
import { StaffMember } from "../staff/staff.model.js";

type Row = AppointmentData & { _id: unknown; updatedAt?: Date };
/** Aerwell's lifecycle in the booking vocabulary of contract §5.7. */
const STATUS: Record<string, string> = {
  booked: "confirmed",
  confirmed: "confirmed",
  checked_in: "checked_in",
  in_progress: "checked_in",
  completed: "completed",
  cancelled: "cancelled",
  no_show: "no_show",
};
export const partnerStatus = (row: Row): string => STATUS[row.status] ?? row.status;

interface Ext {
  status?: string;
  amountCents?: number;
  currency?: string;
  paymentIntentId?: string;
  paidAt?: Date;
  refundedCents?: number;
  refundedAt?: Date;
}
export const externalOf = (row: Row): Ext => (row.externalPayment ?? {}) as Ext;

/** The partner's view of payment. Alfred's own order stays authoritative for what it charged. */
export function paymentView(row: Row) {
  const ext = externalOf(row);
  const status = ext.refundedAt
    ? "refunded"
    : row.paymentStatus === "paid_external"
      ? "paid"
      : row.paymentStatus === "pending_external"
        ? "pending"
        : "none";
  return {
    status,
    // Aerwell's own staff bookings carry no Alfred payment: Alfred charged nothing for them.
    amountCents: ext.amountCents ?? 0,
    currency: ext.currency ?? "usd",
  };
}

/** Display names for a page of appointments, fetched in three queries however many rows. */
export async function loadRefs(rows: Row[]) {
  const ids = (pick: (r: Row) => unknown) => [...new Set(rows.map((r) => String(pick(r))))];
  const [services, locations, staff] = await Promise.all([
    Service.find({ _id: { $in: ids((r) => r.serviceId) } })
      .select("slug title")
      .lean(),
    Location.find({ _id: { $in: ids((r) => r.locationId) } })
      .select("name")
      .lean(),
    StaffMember.find({ _id: { $in: ids((r) => r.providerId) } })
      .select("firstName lastName titlePrefix displayName roleId")
      .lean(),
  ]);
  const roles = await Role.find({ _id: { $in: staff.map((s) => s.roleId) } })
    .select("name")
    .lean();
  const roleName = new Map(roles.map((r) => [String(r._id), r.name]));
  return {
    service: new Map(services.map((s) => [String(s._id), s])),
    location: new Map(locations.map((l) => [String(l._id), l])),
    staff: new Map(
      staff.map((s) => [
        String(s._id),
        { name: providerName(s), role: roleName.get(String(s.roleId)) ?? "Clinician" },
      ])
    ),
  };
}
export type Refs = Awaited<ReturnType<typeof loadRefs>>;

const summaryOf = (row: Row, refs: Refs) => ({
  title: refs.service.get(String(row.serviceId))?.title ?? "Appointment",
  locationName: refs.location.get(String(row.locationId))?.name ?? "",
  staffName: refs.staff.get(String(row.providerId))?.name ?? "",
});

const at = (row: Row, status: string) =>
  [...(row.statusHistory ?? [])].reverse().find((h) => h.status === status)?.at ?? undefined;

/** The booking view of §5.7: identical for create, read, reschedule (status overridden) and orders. */
export function bookingView(row: Row, refs: Refs, status = partnerStatus(row)) {
  const staff = refs.staff.get(String(row.providerId));
  return {
    bookingRef: String(row._id),
    status,
    startAt: row.startAt,
    endAt: row.endAt,
    locationRef: String(row.locationId),
    staff: {
      ref: String(row.providerId),
      name: staff?.name ?? "",
      role: staff?.role ?? "Clinician",
    },
    payment: paymentView(row),
    summary: summaryOf(row, refs),
    ...(row.status === "cancelled"
      ? { cancelledAt: row.cancellation?.at ?? at(row, "cancelled") }
      : {}),
    ...(at(row, "checked_in") ? { checkedInAt: at(row, "checked_in") } : {}),
    ...(row.status === "completed" ? { completedAt: at(row, "completed") } : {}),
  };
}

/** One row of the `GET /orders` stream. */
export function orderItem(row: Row, accountId: string, refs: Refs) {
  return {
    kind: "booking" as const,
    ref: String(row._id),
    accountId,
    status: partnerStatus(row),
    startAt: row.startAt,
    endAt: row.endAt,
    itemRef: refs.service.get(String(row.serviceId))?.slug,
    locationRef: String(row.locationId),
    payment: paymentView(row),
    summary: summaryOf(row, refs),
    updatedAt: row.updatedAt,
  };
}
