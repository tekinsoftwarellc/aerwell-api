import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { at, bookingWorld, pinClock } from "../../test/appointmentFixture.js";
import { ORG } from "../../test/memberFixture.js";
import { as } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { Member } from "../member/member.model.js";
import { Service } from "../service/service.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { Appointment, type AppointmentStatus } from "./appointment.model.js";

// Pinned now: 2027-03-01 12:00 in Los Angeles (the org's default zone).
beforeEach(() => pinClock());
afterEach(() => vi.useRealTimers());
type World = Awaited<ReturnType<typeof bookingWorld>>;

/** Insert a row directly: past visits cannot be booked through the API. */
const row = async (
  w: World,
  memberId: unknown,
  date: string,
  time: string,
  status: AppointmentStatus,
  providerId: unknown = w.provider.staff._id
) =>
  Appointment.create({
    organizationId: ORG,
    memberId,
    serviceId: w.service("red-light-therapy"),
    categoryId: (await Service.findById(w.service("red-light-therapy")).lean())?.categoryId,
    providerId,
    locationId: w.vegas._id,
    startAt: at(date, time),
    endAt: new Date(at(date, time).getTime() + 30 * 60000),
    durationMinutes: 30,
    timeZone: "America/Los_Angeles",
    status,
    modality: "physical",
    price: { decision: "allowance", totalCents: 0 },
    amountDueCents: 0,
    paymentStatus: "not_required",
  });
const overview = async (w: World, memberId: unknown, token = w.director.accessToken) => {
  const res = await as(token).get(`/api/v1/members/${memberId}/overview`);
  expect(res.status).toBe(200);
  return res.body.data;
};

it("computes visit frequency from visit statuses in local days, both sides of every filter", async () => {
  const w = await bookingWorld();
  const ava = await w.member();
  const other = await w.member();
  // Inserted out of date order. Visits = checked_in / in_progress / completed.
  await row(w, ava._id, "2027-02-10", "10:00", "completed");
  await row(w, ava._id, "2027-03-01", "08:00", "completed");
  await row(w, ava._id, "2027-02-23", "00:00", "completed"); // first minute of the Now week
  await row(w, ava._id, "2027-02-22", "23:59", "checked_in"); // last minute of Wk 4
  await row(w, ava._id, "2027-01-31", "00:30", "in_progress"); // first day of the 30
  await row(w, ava._id, "2027-01-30", "23:30", "completed"); // previous 30 days
  await row(w, ava._id, "2027-01-05", "10:00", "completed"); // previous 30 days
  await row(w, ava._id, "2026-06-01", "10:00", "completed"); // total only (> 6 months)
  // Not visits, or not this member.
  await row(w, ava._id, "2027-02-15", "10:00", "cancelled");
  await row(w, ava._id, "2027-02-16", "10:00", "no_show");
  await row(w, ava._id, "2027-02-17", "10:00", "booked");
  await row(w, other._id, "2027-02-20", "10:00", "completed");
  const data = await overview(w, ava._id);
  expect(data.visits).toEqual({
    last30Days: 5,
    previous30Days: 2,
    trend: "increased",
    weekly: [
      { label: "Wk 1", count: 2 },
      { label: "Wk 2", count: 0 },
      { label: "Wk 3", count: 1 },
      { label: "Wk 4", count: 1 },
      { label: "Now", count: 2 },
    ],
    avgPerWeek: 0.3, // 7 visits in the last 26 weeks
    avgPerMonth: 1.2, // 7 visits in the last 6 months
    total: 8,
  });
  const quiet = await overview(w, other._id);
  expect(quiet.visits).toMatchObject({ last30Days: 1, previous30Days: 0, total: 1 });
});

it("lists today's count and the next three upcoming appointments in start order", async () => {
  const w = await bookingWorld();
  const ava = await w.member();
  await row(w, ava._id, "2027-03-20", "09:00", "booked");
  await row(w, ava._id, "2027-03-10", "09:00", "booked");
  await row(w, ava._id, "2027-03-25", "09:00", "booked"); // fourth: beyond the limit
  await row(w, ava._id, "2027-03-05", "09:00", "confirmed");
  await row(w, ava._id, "2027-03-04", "09:00", "cancelled");
  await row(w, ava._id, "2027-03-01", "16:00", "cancelled"); // today, not counted
  await row(w, ava._id, "2027-03-01", "08:00", "completed"); // today, already done
  await row(w, ava._id, "2027-03-01", "15:00", "booked"); // today, still ahead
  await row(w, ava._id, "2027-03-02", "00:00", "booked"); // tomorrow's first minute
  await row(w, ava._id, "2027-02-28", "23:59", "completed"); // yesterday's last minute
  const data = await overview(w, ava._id);
  expect(data.appointments.todayCount).toBe(2);
  expect(data.appointments.upcoming.map((a: { startAt: string }) => a.startAt)).toEqual([
    at("2027-03-01", "15:00").toISOString(),
    at("2027-03-02", "00:00").toISOString(),
    at("2027-03-05", "09:00").toISOString(),
  ]);
  expect(data.appointments.upcoming[0]).toMatchObject({
    status: "booked",
    service: { title: "Red Light Therapy" },
    provider: { displayName: "Dr. Diebel" },
    location: { name: "Aerwell Las Vegas" },
  });
  expect(data.todayAppointment).toMatchObject({
    startAt: at("2027-03-01", "15:00").toISOString(),
  });
});

it("needs APPOINTMENTS view and applies its own scope to every appointment block", async () => {
  const w = await bookingWorld();
  const ava = await w.member();
  const colleague = await staffFixture(false, 1);
  await row(w, ava._id, "2027-02-20", "10:00", "completed");
  await row(w, ava._id, "2027-02-21", "10:00", "completed", colleague.staff._id);
  await row(w, ava._id, "2027-03-01", "15:00", "booked", colleague.staff._id);
  await row(w, ava._id, "2027-03-03", "09:00", "booked");
  const all = await overview(w, ava._id);
  expect(all.visits.total).toBe(2);
  expect(all.appointments.todayCount).toBe(1);
  expect(all.appointments.upcoming).toHaveLength(2);
  // The provider sees only their own appointments.
  await Member.updateOne({ _id: ava._id }, { assignedClinicianIds: [w.provider.staff._id] });
  await StaffMember.updateOne(
    { _id: w.provider.staff._id },
    { permissionOverrides: [{ module: "APPOINTMENTS", level: "view", scope: "own" }] }
  );
  const own = await overview(w, ava._id, w.provider.accessToken);
  expect(own.visits).toMatchObject({ total: 1, last30Days: 1 });
  expect(own.appointments.todayCount).toBe(0);
  expect(own.todayAppointment).toBeNull();
  expect(own.appointments.upcoming.map((a: { startAt: string }) => a.startAt)).toEqual([
    at("2027-03-03", "09:00").toISOString(),
  ]);
  // Without APPOINTMENTS view, every appointment-derived block is null.
  await StaffMember.updateOne(
    { _id: w.provider.staff._id },
    { permissionOverrides: [{ module: "APPOINTMENTS", level: "none", scope: "all" }] }
  );
  const none = await overview(w, ava._id, w.provider.accessToken);
  expect(none).toMatchObject({ visits: null, appointments: null, todayAppointment: null });
});
