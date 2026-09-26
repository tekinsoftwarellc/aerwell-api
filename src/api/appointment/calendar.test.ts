import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DAY, at, bookingWorld, pinClock, shiftFor } from "../../test/appointmentFixture.js";
import { ORG } from "../../test/memberFixture.js";
import { as } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { PtoRequest } from "../schedule/schedule.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { Appointment } from "./appointment.model.js";
import { openSlots, slotCapacity } from "./availability.service.js";

beforeEach(() => pinClock());
afterEach(() => vi.useRealTimers());
type World = Awaited<ReturnType<typeof bookingWorld>>;
const book = async (w: World, memberId: unknown, slug: string, date: string, time: string) => {
  const res = await w.api.post("/api/v1/appointments", {
    ...w.booking(memberId, slug),
    startAt: at(date, time).toISOString(),
  });
  expect(res.status).toBe(201);
  return res.body.data.appointment._id as string;
};
const times = (res: { body: { data: { items: { startAt: string }[] } } }) =>
  res.body.data.items.map((i) => i.startAt);

it("lists a local day as [midnight, next midnight) sorted by start, with filters on both sides", async () => {
  const w = await bookingWorld();
  await shiftFor(w.provider.staff._id, w.vegas._id, DAY, "07:00", "19:00");
  const ava = await w.member([], { firstName: "Ava", lastName: "Morgan" });
  const leo = await w.member(["everhaus-member"], { firstName: "Leo", lastName: "Grant" });
  // Booked out of order so natural order is wrong.
  await book(w, ava._id, "clinician-telehealth-visit", DAY, "15:00");
  await book(w, leo._id, "red-light-therapy", DAY, "09:00");
  const cancelled = await book(w, ava._id, "dexa-scan", DAY, "11:00");
  await w.api.post(`/api/v1/appointments/${cancelled}/cancel`, { reason: "Test" });
  const day = await w.api.get(
    `/api/v1/appointments?from=${DAY}&to=2027-03-11&locationId=${w.vegas._id}`
  );
  expect(day.status).toBe(200);
  expect(times(day)).toEqual([at(DAY, "09:00").toISOString(), at(DAY, "15:00").toISOString()]);
  expect(day.body.data.items[0]).toMatchObject({
    member: { name: "Leo Grant" },
    provider: { displayName: "Dr. Diebel" },
    service: { title: "Red Light Therapy", category: { name: "Everhaus wellness" } },
    location: { name: "Aerwell Las Vegas" },
  });
  const withCancelled = await w.api.get(
    `/api/v1/appointments?from=${DAY}&to=2027-03-11&status=cancelled`
  );
  expect(times(withCancelled)).toEqual([at(DAY, "11:00").toISOString()]);
  const q = await w.api.get(`/api/v1/appointments?from=${DAY}&to=2027-03-11&q=morg`);
  expect(q.body.data.items.map((i: { member: { name: string } }) => i.member.name)).toEqual([
    "Ava Morgan",
  ]);
  const telehealth = (await Appointment.findOne({ memberId: ava._id, status: "booked" }).lean())
    ?.categoryId;
  const byCategory = await w.api.get(
    `/api/v1/appointments?from=${DAY}&to=2027-03-11&categoryId=${telehealth}`
  );
  expect(times(byCategory)).toEqual([at(DAY, "15:00").toISOString()]);
  const nobody = await staffFixture(false, 1);
  const byProvider = await w.api.get(
    `/api/v1/appointments?from=${DAY}&to=2027-03-11&providerId=${nobody.staff._id}`
  );
  expect(byProvider.body.data.items).toEqual([]);
  // Member filter (served by the member index, which is startAt DESC): still ascending.
  const avas = await w.api.get(
    `/api/v1/appointments?from=${DAY}&to=2027-03-11&memberId=${ava._id}&status=booked&status=cancelled`
  );
  expect(times(avas)).toEqual([at(DAY, "11:00").toISOString(), at(DAY, "15:00").toISOString()]);
  const nextDay = await w.api.get("/api/v1/appointments?from=2027-03-11&to=2027-03-12");
  expect(nextDay.body.data.items).toEqual([]);
  // Own-scope providers see only their own appointments.
  await StaffMember.updateOne(
    { _id: nobody.staff._id },
    { permissionOverrides: [{ module: "APPOINTMENTS", level: "view", scope: "own" }] }
  );
  const own = await as(nobody.accessToken).get(`/api/v1/appointments?from=${DAY}&to=2027-03-11`);
  expect(own.body.data.items).toEqual([]);
  const mine = await as(w.provider.accessToken).get(
    `/api/v1/appointments?from=${DAY}&to=2027-03-11`
  );
  expect(mine.body.data.items).toHaveLength(2);
});

it("uses 23- and 25-hour local days across DST changes", async () => {
  const w = await bookingWorld();
  const member = await w.member();
  // Spring forward (2027-03-14): 00:30 on the 15th PDT is 07:30Z, still "the 15th".
  await shiftFor(w.provider.staff._id, w.vegas._id, "2027-03-14", "07:00", "19:00");
  await shiftFor(w.provider.staff._id, w.vegas._id, "2027-03-15", "07:00", "19:00");
  await book(w, member._id, "clinician-telehealth-visit", "2027-03-14", "18:00");
  await book(w, member._id, "clinician-telehealth-visit", "2027-03-15", "07:00");
  const spring = await w.api.get("/api/v1/appointments?from=2027-03-14&to=2027-03-15");
  expect(times(spring)).toEqual(["2027-03-15T01:00:00.000Z"]);
  const summary = await w.api.get("/api/v1/appointments/summary?from=2027-03-13&to=2027-03-16");
  expect(summary.body.data.days).toEqual([
    { date: "2027-03-13", count: 0 },
    { date: "2027-03-14", count: 1 },
    { date: "2027-03-15", count: 1 },
  ]);
  // Fall back (2027-11-07): an 18:00 PST booking is 02:00Z on the 8th but belongs to the 7th.
  await shiftFor(w.provider.staff._id, w.vegas._id, "2027-11-07", "07:00", "19:00");
  const fall = await book(w, member._id, "clinician-telehealth-visit", "2027-11-07", "18:00");
  expect((await Appointment.findById(fall).lean())?.startAt.toISOString()).toBe(
    "2027-11-08T02:00:00.000Z"
  );
  const month = await w.api.get("/api/v1/appointments/summary?month=2027-11");
  expect(month.body.data.total).toBe(1);
  expect(month.body.data.days.find((d: { date: string }) => d.date === "2027-11-07").count).toBe(1);
  expect(month.body.data.days).toHaveLength(30);
  // Availability on the spring-forward day is computed in PDT (UTC-7).
  const slots = await w.api.get(
    `/api/v1/availability?serviceId=${w.service("clinician-telehealth-visit")}&locationId=${w.vegas._id}&from=2027-03-14&to=2027-03-15`
  );
  expect(slots.body.data.slots[0].startAt).toBe("2027-03-14T14:00:00.000Z"); // 07:00 PDT
  // 18:00 PDT is booked, so the last free start is 17:00 PDT.
  expect(slots.body.data.slots.at(-1).startAt).toBe("2027-03-15T00:00:00.000Z");
});

it("derives availability from shifts, hours, PTO and bookings", async () => {
  const w = await bookingWorld();
  const member = await w.member();
  const url = (from: string, extra = "") =>
    `/api/v1/availability?serviceId=${w.service("clinician-telehealth-visit")}&locationId=${w.vegas._id}&from=${from}${extra}`;
  // DAY shift 08:00–17:00, 60 min, 15-min grid: 08:00 … 16:00 = 33 starts.
  const open = await w.api.get(url(DAY));
  expect(open.body.data.slots).toHaveLength(33);
  expect(open.body.data.slots[0]).toMatchObject({
    startAt: at(DAY, "08:00").toISOString(),
    providerName: "Dr. Diebel",
    remaining: 1,
  });
  await book(w, member._id, "clinician-telehealth-visit", DAY, "09:00");
  const after = await w.api.get(url(DAY));
  // 08:15 … 09:45 overlap the 09:00–10:00 booking (7 starts).
  expect(after.body.data.slots).toHaveLength(26);
  expect(after.body.data.slots.map((s: { startAt: string }) => s.startAt)).not.toContain(
    at(DAY, "09:30").toISOString()
  );
  expect(after.body.data.slots.map((s: { startAt: string }) => s.startAt)).toContain(
    at(DAY, "10:00").toISOString()
  );
  await PtoRequest.create({
    organizationId: ORG,
    staffId: w.provider.staff._id,
    startDate: DAY,
    endDate: DAY,
    days: 1,
    type: "sick",
    status: "approved",
  });
  expect((await w.api.get(url(DAY))).body.data.slots).toEqual([]);
  const pending = await w.api.get(url("2027-03-11"));
  expect(pending.body.data.slots).toEqual([]); // no shift that day
  const tooLong = await w.api.get(url(DAY, "&to=2027-04-10"));
  expect(tooLong.body.code).toBe("INVALID_DATE_RANGE");
});

it("slot math: capacity sharing only for the same group start; nothing in the past", () => {
  const base = new Date("2027-03-10T16:00:00.000Z");
  const ctx = {
    durationMinutes: 60,
    serviceId: "group",
    capacityMax: 3,
    windows: [{ start: base, end: new Date(base.getTime() + 2 * 3_600_000) }],
    busy: [{ startAt: base, endAt: new Date(base.getTime() + 3_600_000), serviceId: "group" }],
    now: new Date("2027-03-01T00:00:00.000Z"),
  };
  expect(slotCapacity(ctx, base)).toBe(2);
  expect(slotCapacity({ ...ctx, busy: [{ ...ctx.busy[0]!, serviceId: "other" }] }, base)).toBe(0);
  expect(slotCapacity(ctx, new Date(base.getTime() + 30 * 60_000))).toBe(0);
  expect(slotCapacity({ ...ctx, now: new Date(base.getTime() + 1) }, base)).toBe(0);
  expect(openSlots(ctx).map((s) => s.remaining)).toEqual([2, 3]);
});

it("detail, member tab, summary and the wired seams (scheduledCount, PTO coverage)", async () => {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-essential"], { firstName: "Marcus", lastName: "Lee" });
  const soon = await book(w, member._id, "clinician-telehealth-visit", DAY, "09:00");
  await shiftFor(w.provider.staff._id, w.vegas._id, "2027-03-20");
  await book(w, member._id, "clinician-telehealth-visit", "2027-03-20", "09:00");
  const detail = await w.api.get(`/api/v1/appointments/${soon}`);
  expect(detail.body.data).toMatchObject({
    membership: { name: "Aerwell Essential" },
    bookingSource: "staff",
    visitsThisMonth: 0,
    allowedTransitions: ["confirmed", "checked_in", "no_show"],
    price: { decision: "allowance" },
  });
  const upcoming = await w.api.get(`/api/v1/members/${member._id}/appointments?scope=upcoming`);
  expect(times(upcoming)).toEqual([
    at(DAY, "09:00").toISOString(),
    at("2027-03-20", "09:00").toISOString(),
  ]);
  const past = await w.api.get(`/api/v1/members/${member._id}/appointments?scope=past`);
  expect(past.body.data.items).toEqual([]);
  const search = await w.api.get(`/api/v1/members/${member._id}/appointments?scope=all&q=dexa`);
  expect(search.body.data.items).toEqual([]);
  const services = await w.api.get("/api/v1/services?limit=50");
  const telehealth = services.body.data.items.find(
    (s: { slug: string }) => s.slug === "clinician-telehealth-visit"
  );
  expect(telehealth.scheduledCount).toBe(2);
  const month = await w.api.get("/api/v1/appointments/summary?month=2027-03");
  expect(month.body.data.total).toBe(2);
  const pto = await PtoRequest.create({
    organizationId: ORG,
    staffId: w.provider.staff._id,
    startDate: DAY,
    endDate: DAY,
    days: 1,
    type: "vacation",
  });
  const review = await w.api.get(`/api/v1/staff/pto-requests/${pto._id}`);
  expect(review.body.data.coverageConflicts).toEqual([
    {
      appointmentId: soon,
      startAt: at(DAY, "09:00").toISOString(),
      description: "Aerwell Clinician Telehealth Visit",
    },
  ]);
});
