import { afterEach, expect, it, vi } from "vitest";
import { as, grant, scheduleFixture } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { Certification, Employment } from "../staff/staff-details.model.js";
import { StaffMember } from "../staff/staff.model.js";

const week = (available: boolean) =>
  Array.from({ length: 7 }, (_, weekday) =>
    available && weekday > 0 && weekday < 6
      ? { weekday, available: true, start: "08:00", end: "17:00" }
      : { weekday, available: false }
  );
afterEach(() => vi.useRealTimers());
/** Pin only Date, before any token is minted, so JWT and "today" agree. */
const pin = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

it("reads a default availability template, validates and saves it with scope checks", async () => {
  const { director, nurse, boss } = await scheduleFixture();
  const path = `/api/v1/staff/${nurse.staff._id}/availability`;
  const initial = await boss.get(path);
  expect(initial.body.data.days).toHaveLength(7);
  expect(initial.body.data.days.every((d: { available: boolean }) => !d.available)).toBe(true);
  expect((await boss.put(path, { days: week(true).slice(1) })).status).toBe(400);
  const broken = week(true).map((d) => (d.weekday === 1 ? { weekday: 1, available: true } : d));
  expect((await boss.put(path, { days: broken })).status).toBe(400);
  expect((await boss.put(path, { days: week(true) })).status).toBe(200);
  expect((await boss.get(path)).body.data.days[1]).toMatchObject({
    available: true,
    start: "08:00",
  });
  const nurseApi = as(nurse.accessToken);
  expect((await nurseApi.get(path)).status).toBe(200);
  expect((await nurseApi.put(path, { days: week(false) })).status).toBe(403);
  await grant(nurse.staff._id, "edit", "own");
  expect((await nurseApi.put(path, { days: week(false) })).status).toBe(200);
  expect((await nurseApi.get(`/api/v1/staff/${director.staff._id}/availability`)).status).toBe(404);
});

it("lists incomplete onboarding and records checklist progress", async () => {
  const { nurse, boss } = await scheduleFixture();
  await StaffMember.updateOne(
    { _id: nurse.staff._id },
    { accountStatus: "pending_onboarding", firstName: "Sam", lastName: "Oklar" }
  );
  await Employment.create({
    organizationId: "org-test",
    staffId: nurse.staff._id,
    startDate: "2027-07-14",
  });
  const list = await boss.get("/api/v1/staff/onboarding");
  expect(list.body.data).toHaveLength(1);
  expect(list.body.data[0]).toMatchObject({
    staff: { firstName: "Sam" },
    employment: { startDate: "2027-07-14" },
    steps: [
      { key: "paperwork", complete: false },
      { key: "training", complete: false },
    ],
  });
  const path = `/api/v1/staff/${nurse.staff._id}/onboarding`;
  expect((await boss.patch(path, { steps: [{ key: "paperwork", complete: true }] })).status).toBe(
    400
  );
  const steps = [
    { key: "paperwork", complete: true },
    { key: "training", complete: false },
  ];
  expect((await boss.patch(path, { steps })).status).toBe(200);
  expect((await as(nurse.accessToken).patch(path, { steps })).status).toBe(403);
  // An activated hire with an incomplete checklist stays listed until every step is done.
  await StaffMember.updateOne({ _id: nurse.staff._id }, { accountStatus: "active" });
  expect((await boss.get("/api/v1/staff/onboarding")).body.data[0].steps[0].complete).toBe(true);
  await boss.patch(path, { steps: steps.map((s) => ({ ...s, complete: true })) });
  expect((await boss.get("/api/v1/staff/onboarding")).body.data).toEqual([]);
});

it("returns only active providers", async () => {
  const { director, nurse, boss } = await scheduleFixture();
  await StaffMember.updateOne({ _id: director.staff._id }, { isProvider: true });
  const inactive = await staffFixture(false, 1);
  await StaffMember.updateOne(
    { _id: inactive.staff._id },
    { isProvider: true, accountStatus: "deactivated" }
  );
  const ids = (await boss.get("/api/v1/staff/providers")).body.data.map(
    (s: { _id: string }) => s._id
  );
  expect(ids).toEqual([String(director.staff._id)]);
  expect(ids).not.toContain(String(nurse.staff._id));
});

it("builds rule-based overview priorities in the location day", async () => {
  pin("2027-01-08T20:00:00Z");
  const { nurse, shift, boss } = await scheduleFixture();
  await StaffMember.updateOne(
    { _id: nurse.staff._id },
    { firstName: "Ana", lastName: "Whitefield" }
  );
  await boss.post("/api/v1/staff/shifts", {
    ...shift,
    date: "2027-01-09",
    staffId: null,
    stationName: "Front Desk",
    startTime: "14:00",
    endTime: "20:00",
  });
  await boss.post("/api/v1/staff/shifts", { ...shift, date: "2027-01-08" });
  await Certification.create({
    organizationId: "org-test",
    staffId: nurse.staff._id,
    name: "Phlebotomy license",
    expirationDate: "2027-01-26",
  });
  const hire = await staffFixture(false, 2);
  await StaffMember.updateOne(
    { _id: hire.staff._id },
    { accountStatus: "pending_onboarding", firstName: "Sam" }
  );
  await as(nurse.accessToken).post("/api/v1/staff/pto-requests", {
    startDate: "2027-01-15",
    endDate: "2027-01-17",
    type: "vacation",
  });
  const overview = await boss.get("/api/v1/staff/overview");
  expect(overview.status).toBe(200);
  const data = overview.body.data;
  expect(data.date).toBe("2027-01-08");
  expect(data.schedule.items).toHaveLength(1);
  expect(data.pendingPto).toHaveLength(1);
  expect(data.onboarding.map((o: { staff: { firstName: string } }) => o.staff.firstName)).toEqual([
    "Sam",
  ]);
  expect(data.priorities.map((p: { kind: string }) => p.kind)).toEqual([
    "coverage",
    "certification",
    "onboarding",
    "pto",
  ]);
  expect(data.priorities[0]).toMatchObject({
    title: "Front Desk uncovered 2pm–8pm Sat, Jan 9",
    actionType: "assign_coverage",
  });
  expect(data.priorities[1]).toMatchObject({
    title: "Ana Whitefield's Phlebotomy license expires in 18 days",
    actionType: "send_reminder",
  });
  expect(data.prioritiesTotal).toBe(4);
  const explicit = await boss.get("/api/v1/staff/overview?date=2027-01-09");
  expect(explicit.body.data.schedule.items).toHaveLength(1);
  expect(explicit.body.data.schedule.items[0].stationName).toBe("Front Desk");
});

it("defaults time-off to the current location year and reports upcoming approved leave", async () => {
  pin("2027-01-01T05:00:00Z"); // Still 31 Dec 2026 in Los Angeles.
  const { nurse, boss } = await scheduleFixture();
  const created = await as(nurse.accessToken).post("/api/v1/staff/pto-requests", {
    startDate: "2027-01-10",
    endDate: "2027-01-11",
    type: "vacation",
  });
  await boss.post(`/api/v1/staff/pto-requests/${created.body.data._id}/approve`);
  const current = (await boss.get(`/api/v1/staff/${nurse.staff._id}/time-off`)).body.data;
  expect(current.balance.year).toBe(2026);
  expect(current.upcoming).toMatchObject({ startDate: "2027-01-10", endDate: "2027-01-11" });
  const next = (await boss.get(`/api/v1/staff/${nurse.staff._id}/time-off?year=2027`)).body.data;
  expect(next.balance).toMatchObject({ usedDays: 2, remainingDays: 13 });
  expect(next.items).toHaveLength(1);
});
