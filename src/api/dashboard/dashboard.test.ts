import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DAY, at, bookingWorld, pinClock, shiftFor } from "../../test/appointmentFixture.js";
import { ORG, memberRow, staffWith } from "../../test/memberFixture.js";
import { as } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { Appointment, type AppointmentStatus } from "../appointment/appointment.model.js";
import { AuditEvent } from "../audit/audit.js";
import { issueSession } from "../auth/session.service.js";
import { LabPanel, Scan } from "../clinical/records.model.js";
import { MemberFlag, MemberNote } from "../member/member.model.js";
import { PtoRequest } from "../schedule/schedule.model.js";
import { Service } from "../service/service.model.js";
import { OrganizationSettings } from "../settings/settings.model.js";
import { StaffMember } from "../staff/staff.model.js";

// Pinned now: 2027-03-01 12:00 Los Angeles. Queries name DAY (2027-03-10, a Wednesday).
beforeEach(() => pinClock());
afterEach(() => vi.useRealTimers());
type World = Awaited<ReturnType<typeof bookingWorld>>;
const SLUG = "clinician-telehealth-visit";

const appt = async (
  w: World,
  memberId: unknown,
  startAt: Date,
  status: AppointmentStatus = "booked",
  providerId: unknown = w.provider.staff._id
) =>
  Appointment.create({
    organizationId: ORG,
    memberId,
    serviceId: w.service(SLUG),
    categoryId: (await Service.findById(w.service(SLUG)).lean())?.categoryId,
    providerId,
    locationId: w.vegas._id,
    startAt,
    endAt: new Date(startAt.getTime() + 30 * 60000),
    durationMinutes: 30,
    timeZone: "America/Los_Angeles",
    status,
    modality: "virtual",
    price: { decision: "retail", totalCents: 0 },
    amountDueCents: 0,
    paymentStatus: "not_required",
  });
const get = async (token: string, path: string) => {
  const res = await as(token).get(`/api/v1/dashboard/${path}`);
  expect(res.status).toBe(200);
  return res.body.data;
};

it("counts my live appointments in the local day, both sides of every bound and filter", async () => {
  const w = await bookingWorld();
  const m = await memberRow();
  await appt(w, m._id, at(DAY, "00:00")); // first instant of the day
  await appt(w, m._id, at(DAY, "23:59"), "completed");
  await appt(w, m._id, at(DAY, "12:00"), "cancelled");
  await appt(w, m._id, at(DAY, "13:00"), "no_show");
  await appt(w, m._id, at("2027-03-11", "00:00")); // next local midnight: excluded
  await appt(w, m._id, at("2027-03-09", "23:59")); // previous day
  await appt(w, m._id, at(DAY, "10:00"), "booked", w.director.staff._id); // someone else's
  const mine = await get(w.provider.accessToken, `summary?date=${DAY}`);
  expect(mine.kpis.myAppointments).toBe(2);
  expect(mine.date).toBe(DAY);
  expect(mine.timeZone).toBe("America/Los_Angeles");
  expect(mine.greeting).toEqual({ name: "Philip", partOfDay: "afternoon" });
  expect((await get(w.director.accessToken, `summary?date=${DAY}`)).kpis.myAppointments).toBe(1);
  // Undefined KPIs are explicit, never a made-up number.
  expect(mine.kpis.internalMeetings).toEqual({
    status: "not_configured",
    reason: expect.any(String),
  });
  expect(mine.kpis.newAssessments.status).toBe("not_configured");
  expect(mine.assessments.status).toBe("not_configured");
  expect(mine.messages.status).toBe("not_configured");
});

it("computes the day in the organization time zone", async () => {
  const w = await bookingWorld();
  const m = await memberRow();
  await appt(w, m._id, at(DAY, "22:30")); // 01:30 on Mar 11 in New York
  await OrganizationSettings.updateOne(
    { organizationId: ORG },
    { $set: { timeZone: "America/New_York" } },
    { upsert: true }
  );
  const token = w.provider.accessToken;
  expect((await get(token, `summary?date=${DAY}`)).kpis.myAppointments).toBe(0);
  expect((await get(token, "summary?date=2027-03-11")).kpis.myAppointments).toBe(1);
  const today = await get(token, "summary");
  expect([today.date, today.greeting.partOfDay]).toEqual(["2027-03-01", "afternoon"]); // 15:00 NY
  // Access tokens are short-lived: mint one at each new pinned time.
  const fresh = async () => (await issueSession(String(w.provider.staff._id), 0)).accessToken;
  pinClock(new Date("2027-03-01T14:00:00Z")); // 09:00 NY
  expect((await get(await fresh(), "summary")).greeting.partOfDay).toBe("morning");
  pinClock(new Date("2027-03-01T23:00:00Z")); // 18:00 NY
  expect((await get(await fresh(), "summary")).greeting.partOfDay).toBe("evening");
});

it("hides every widget the reader lacks permission for instead of leaking a count", async () => {
  const staffOnly = await staffWith({ STAFF_RECORDS: "view" });
  const m = await memberRow();
  await LabPanel.create({ organizationId: ORG, memberId: m._id, drawnAt: new Date() });
  const data = await get(staffOnly.accessToken, "summary");
  expect(data.kpis.myAppointments).toBeNull();
  for (const key of ["labsScans", "clinicalNotes", "waitlists"]) expect(data[key]).toBeNull();
  expect(data.staffToday).not.toBeNull();
  expect(await get(staffOnly.accessToken, "agenda")).toBeNull();
  const labsNoRecords = await staffWith({ LABS_SCANS: "view", CLINICAL_NOTES: "view" });
  const other = await get(labsNoRecords.accessToken, "summary");
  expect([other.labsScans, other.clinicalNotes, other.staffToday]).toEqual([null, null, null]);
  expect((await as(staffOnly.accessToken).get("/api/v1/dashboard/summary?date=03-10")).status).toBe(
    400
  );
});

it("lists new labs and scans within own scope, newest first, reviewed ones excluded", async () => {
  const own = await staffWith({ MEMBER_RECORDS: "view", LABS_SCANS: "view" }, "own");
  const all = await staffWith({ MEMBER_RECORDS: "view", LABS_SCANS: "view" });
  const mine = await memberRow({ assignedClinicianIds: [own.staff._id] });
  const theirs = await memberRow();
  const lab = (memberId: unknown, drawnAt: string, extra: object = {}) =>
    LabPanel.create({
      organizationId: ORG,
      memberId,
      drawnAt: new Date(drawnAt),
      panelType: "Blood Panel",
      ...extra,
    });
  await lab(mine._id, "2027-02-01T10:00:00Z");
  await lab(mine._id, "2027-02-03T10:00:00Z", { reviewStatus: "reviewed" });
  await lab(theirs._id, "2027-02-04T10:00:00Z");
  await Scan.create({
    organizationId: ORG,
    memberId: mine._id,
    performedAt: new Date("2027-02-02T10:00:00Z"),
  });
  const scoped = (await get(own.accessToken, "summary")).labsScans;
  expect(scoped.newCount).toBe(2);
  expect(scoped.counts).toEqual({ labs: 1, scans: 1 });
  expect(scoped.items.map((i: { label: string; memberName: string }) => i.label)).toEqual([
    "DEXA Scan",
    "Blood Panel",
  ]);
  expect(scoped.items[0].memberName).toBe(`${mine.firstName} ${mine.lastName}`);
  const everyone = (await get(all.accessToken, "summary")).labsScans;
  expect(everyone.newCount).toBe(3);
  expect(everyone.items.map((i: { memberId: string }) => i.memberId)).toEqual([
    String(mine._id),
    String(theirs._id),
    String(mine._id),
  ]);
  const audited = await AuditEvent.countDocuments({
    actorId: String(own.staff._id),
    targetType: "Dashboard",
  });
  expect(audited).toBe(1);
});

it("groups my unread clinical notes by author within scope", async () => {
  const reader = await staffWith({ MEMBER_RECORDS: "view", CLINICAL_NOTES: "view" }, "own");
  const sarah = await staffFixture(false);
  await StaffMember.updateOne(
    { _id: sarah.staff._id },
    { firstName: "Sarah", lastName: "Park", titlePrefix: "RN" }
  );
  const john = await staffFixture(false);
  await StaffMember.updateOne({ _id: john.staff._id }, { firstName: "John", lastName: "Time" });
  const mine = await memberRow({ assignedClinicianIds: [reader.staff._id] });
  const theirs = await memberRow();
  const note = (memberId: unknown, authorId: unknown, readBy: unknown[] = []) =>
    MemberNote.create({ organizationId: ORG, memberId, authorId, body: "Note body", readBy });
  await note(mine._id, john.staff._id);
  await note(mine._id, sarah.staff._id);
  await note(mine._id, sarah.staff._id);
  await note(mine._id, sarah.staff._id, [reader.staff._id]); // already read
  await note(mine._id, reader.staff._id); // my own
  await note(theirs._id, john.staff._id); // outside own scope
  const notes = (await get(reader.accessToken, "summary")).clinicalNotes;
  expect(notes).toEqual({
    newCount: 3,
    items: [
      { authorId: String(sarah.staff._id), authorName: "RN Sarah Park", count: 2 },
      { authorId: String(john.staff._id), authorName: "John Time", count: 1 },
    ],
  });
});

it("groups open waitlist flags by service and lists staff on shift today", async () => {
  const w = await bookingWorld();
  const a = await memberRow();
  const b = await memberRow();
  const flag = (memberId: unknown, service: string | null, extra: object = {}) =>
    MemberFlag.create({
      organizationId: ORG,
      memberId,
      category: "waitlist",
      title: "Waitlist",
      raisedBy: "system",
      relatedServiceId: service ? w.service(service) : undefined,
      ...extra,
    });
  await flag(a._id, "dexa-scan");
  await flag(b._id, "vo2-max-test");
  await flag(a._id, "vo2-max-test");
  await flag(b._id, "vo2-max-test"); // same member twice counts once
  await flag(b._id, "dexa-scan", { resolvedAt: new Date() }); // b has no open DEXA flag
  await flag(b._id, "dexa-scan", { category: "billing" });
  const data = await get(w.director.accessToken, `summary?date=${DAY}`);
  expect(data.waitlists).toEqual({
    memberCount: 2,
    items: [
      { serviceId: w.service("vo2-max-test"), serviceName: "VO2 Max Test", memberCount: 2 },
      { serviceId: w.service("dexa-scan"), serviceName: "DEXA Scan", memberCount: 1 },
    ],
  });
  await shiftFor(w.director.staff._id, w.vegas._id, DAY, "07:00", "15:00");
  await shiftFor(w.director.staff._id, w.vegas._id, "2027-03-11");
  const staffToday = (await get(w.director.accessToken, `summary?date=${DAY}`)).staffToday;
  expect(staffToday.count).toBe(2);
  expect(
    staffToday.items.map((i: { name: string; startTime: string; endTime: string }) => [
      i.name,
      i.startTime,
      i.endTime,
    ])
  ).toEqual([
    ["Test Actor", "07:00", "15:00"],
    ["Dr. Philip Diebel", "08:00", "17:00"],
  ]);
  const own = await staffWith({ STAFF_RECORDS: "view" }, "own");
  await shiftFor(own.staff._id, w.vegas._id, DAY, "09:00", "10:00");
  const ownView = (await get(own.accessToken, `summary?date=${DAY}`)).staffToday;
  expect(ownView.items.map((i: { staffId: string }) => i.staffId)).toEqual([String(own.staff._id)]);
});

it("builds a Sunday-first week strip and my day agenda with category colours", async () => {
  const w = await bookingWorld();
  const m = await memberRow({ firstName: "Ava", lastName: "Stone" });
  await appt(w, m._id, at(DAY, "14:00"));
  await appt(w, m._id, at(DAY, "08:30"), "checked_in");
  await appt(w, m._id, at(DAY, "09:00"), "cancelled");
  await appt(w, m._id, at("2027-03-07", "09:00")); // Sunday
  await appt(w, m._id, at("2027-03-14", "09:00")); // next Sunday: outside the week
  await appt(w, m._id, at(DAY, "11:00"), "booked", w.director.staff._id);
  const agenda = await get(w.provider.accessToken, `agenda?date=${DAY}`);
  expect(agenda.weekStart).toBe("2027-03-07");
  expect(agenda.days.map((d: { count: number }) => d.count)).toEqual([1, 0, 0, 2, 0, 0, 0]);
  expect(agenda.items.map((i: { status: string }) => i.status)).toEqual(["checked_in", "booked"]);
  expect(agenda.items[0]).toMatchObject({
    serviceTitle: "Aerwell Clinician Telehealth Visit",
    memberName: "Ava Stone",
    category: { name: "Clinician visits", color: expect.any(String) },
  });
  expect(agenda.legend).toEqual([agenda.items[0].category]);
  // Provider without MEMBER_RECORDS: times and services only.
  await StaffMember.updateOne(
    { _id: w.provider.staff._id },
    { $set: { permissionOverrides: [{ module: "MEMBER_RECORDS", level: "none", scope: "all" }] } }
  );
  const blind = await get(w.provider.accessToken, `agenda?date=${DAY}`);
  expect(blind.items[0].memberName).toBeNull();
});

it("derives Daily Outlook actions from real data only", async () => {
  const w = await bookingWorld();
  const m = await memberRow();
  const empty = await get(w.director.accessToken, "outlook");
  expect(empty).toMatchObject({ source: "rules", total: 0, actions: [] });
  await LabPanel.create({ organizationId: ORG, memberId: m._id, drawnAt: new Date() });
  await Scan.create({ organizationId: ORG, memberId: m._id, performedAt: new Date() });
  await Scan.create({ organizationId: ORG, memberId: m._id, performedAt: new Date() });
  await MemberFlag.create({
    organizationId: ORG,
    memberId: m._id,
    category: "waitlist",
    title: "IV",
    raisedBy: "system",
    relatedServiceId: w.service("dexa-scan"),
  });
  await PtoRequest.create({
    organizationId: ORG,
    staffId: w.provider.staff._id,
    startDate: "2027-03-20",
    endDate: "2027-03-20",
    days: 1,
    type: "vacation",
  });
  const outlook = await get(w.director.accessToken, "outlook");
  expect(
    outlook.actions.map((a: { title: string; detail: string; cta: string }) => [
      a.title,
      a.detail,
      a.cta,
    ])
  ).toEqual([
    ["Reports to Review", "2 DEXA Scans, 1 Lab Result", "Review"],
    ["DEXA Scan Waitlist", "1 Member", "Schedule"],
    ["Time Off Requests", "1 to approve", "Review"],
  ]);
  expect(outlook.total).toBe(3);
  expect(outlook.message).toEqual(expect.any(String));
  // Only STAFF_RECORDS editors are asked to approve time off.
  const nurse = await staffWith({ STAFF_RECORDS: "view", MEMBER_RECORDS: "view" });
  const theirs = await get(nurse.accessToken, "outlook");
  expect(theirs.actions.map((a: { kind: string }) => a.kind)).toEqual(["schedule_waitlist"]);
});
