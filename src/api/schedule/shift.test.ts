import { expect, it } from "vitest";
import { as, grant, scheduleFixture } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { Location } from "../location/location.model.js";
import { StaffMember } from "../staff/staff.model.js";

it("serializes concurrent shifts, rejects overlap, allows adjacent edges and sums hours", async () => {
  const { nurse, shift, boss } = await scheduleFixture();
  const results = await Promise.all([
    boss.post("/api/v1/staff/shifts", shift),
    boss.post("/api/v1/staff/shifts", shift),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(results.find((r) => r.status === 409)?.body.code).toBe("SHIFT_OVERLAP");
  expect(
    (await boss.post("/api/v1/staff/shifts", { ...shift, startTime: "12:00", endTime: "14:00" }))
      .status
  ).toBe(201);
  const month = await boss.get(`/api/v1/staff/${nurse.staff._id}/shifts?month=2027-03`);
  expect(month.status).toBe(200);
  expect(month.body.data.totalHours).toBe(6);
  const id = results.find((r) => r.status === 201)?.body.data._id;
  const overlapping = await boss.patch(`/api/v1/staff/shifts/${id}`, { endTime: "13:00" });
  expect(overlapping.body.code).toBe("SHIFT_OVERLAP");
  expect((await boss.patch(`/api/v1/staff/shifts/${id}`, { startTime: "07:00" })).status).toBe(200);
  expect((await boss.delete(`/api/v1/staff/shifts/${id}`)).status).toBe(200);
  expect((await boss.delete(`/api/v1/staff/shifts/${id}`)).status).toBe(404);
  const actions = await AuditEvent.find({ targetType: "Shift" }).distinct("action");
  expect(actions.sort()).toEqual(["created", "deleted", "updated"]);
});

it("counts elapsed hours across the spring-forward night", async () => {
  const { nurse, shift, boss } = await scheduleFixture();
  const created = await boss.post("/api/v1/staff/shifts", {
    ...shift,
    date: "2027-03-14",
    startTime: "00:00",
    endTime: "04:00",
  });
  expect(created.status).toBe(201);
  expect(created.body.data.startAt).toBe("2027-03-14T08:00:00.000Z");
  expect(created.body.data.endAt).toBe("2027-03-14T11:00:00.000Z");
  const month = await boss.get(`/api/v1/staff/${nurse.staff._id}/shifts?month=2027-03`);
  expect(month.body.data.totalHours).toBe(3);
  const invalid = await boss.post("/api/v1/staff/shifts", {
    ...shift,
    date: "2027-03-14",
    startTime: "02:30",
    endTime: "05:00",
  });
  expect(invalid.status).toBe(422);
  expect(invalid.body.code).toBe("INVALID_LOCAL_TIME");
});

it("uses exclusive day/week/month ranges and sorts by start instant", async () => {
  const { shift, boss } = await scheduleFixture();
  // Inserted out of chronological order so the natural order is wrong.
  for (const [date, startTime, endTime] of [
    ["2027-03-10", "13:00", "15:00"],
    ["2027-03-10", "08:00", "10:00"],
    ["2027-03-11", "08:00", "10:00"],
    ["2027-03-14", "09:00", "10:00"],
    ["2027-03-15", "09:00", "10:00"],
    ["2027-04-01", "09:00", "10:00"],
  ])
    expect(
      (await boss.post("/api/v1/staff/shifts", { ...shift, date, startTime, endTime })).status
    ).toBe(201);
  const day = await boss.get("/api/v1/staff/shifts?view=day&date=2027-03-10");
  expect(day.body.data.items.map((s: { startTime: string }) => s.startTime)).toEqual([
    "08:00",
    "13:00",
  ]);
  expect(day.body.data).toMatchObject({ from: "2027-03-10", to: "2027-03-11" });
  const week = await boss.get("/api/v1/staff/shifts?view=week&date=2027-03-10");
  expect(week.body.data.items.map((s: { date: string }) => s.date)).toEqual([
    "2027-03-10",
    "2027-03-10",
    "2027-03-11",
    "2027-03-14",
  ]);
  const month = await boss.get("/api/v1/staff/shifts?view=month&date=2027-03-20");
  expect(month.body.data.items).toHaveLength(5);
  expect(month.body.data).toMatchObject({ from: "2027-03-01", to: "2027-04-01" });
});

it("filters by staff, role and name on both sides", async () => {
  const { director, nurse, shift, boss } = await scheduleFixture();
  await StaffMember.updateOne(
    { _id: director.staff._id },
    { firstName: "Philip", lastName: "Diebel" }
  );
  await boss.post("/api/v1/staff/shifts", shift);
  await boss.post("/api/v1/staff/shifts", {
    ...shift,
    staffId: String(director.staff._id),
    positionRoleId: String(director.role._id),
  });
  const names = async (query: string) =>
    (await boss.get(`/api/v1/staff/shifts?date=2027-03-10&${query}`)).body.data.items.map(
      (s: { staffId: { firstName: string } }) => s.staffId.firstName
    );
  expect((await names("")).sort()).toEqual(["Philip", "Theresa"]);
  expect(await names("q=ther")).toEqual(["Theresa"]);
  expect(await names("q=diebel")).toEqual(["Philip"]);
  expect(await names(`roleIds=${nurse.role._id}`)).toEqual(["Theresa"]);
  expect(await names(`roleIds[]=${director.role._id}`)).toEqual(["Philip"]);
  expect(await names(`staffId=${director.staff._id}`)).toEqual(["Philip"]);
});

it("enforces view versus edit and own scope", async () => {
  const { director, nurse, shift, boss } = await scheduleFixture();
  const nurseApi = as(nurse.accessToken);
  expect((await nurseApi.get("/api/v1/staff/shifts?date=2027-03-10")).status).toBe(200);
  expect((await nurseApi.post("/api/v1/staff/shifts", shift)).status).toBe(403);
  const created = await boss.post("/api/v1/staff/shifts", {
    ...shift,
    staffId: String(director.staff._id),
  });
  await grant(nurse.staff._id, "edit", "own");
  expect((await nurseApi.post("/api/v1/staff/shifts", shift)).status).toBe(201);
  expect(
    (await nurseApi.post("/api/v1/staff/shifts", { ...shift, staffId: String(director.staff._id) }))
      .status
  ).toBe(404);
  expect((await nurseApi.post("/api/v1/staff/shifts", { ...shift, staffId: null })).status).toBe(
    404
  );
  expect((await nurseApi.delete(`/api/v1/staff/shifts/${created.body.data._id}`)).status).toBe(404);
  const visible = await nurseApi.get("/api/v1/staff/shifts?date=2027-03-10");
  expect(visible.body.data.items).toHaveLength(1);
  expect(visible.body.data.items[0].staffId._id).toBe(String(nurse.staff._id));
  expect(
    (await nurseApi.get(`/api/v1/staff/${director.staff._id}/shifts?month=2027-03`)).status
  ).toBe(404);
  const none = await staffFixture(false, 1);
  await grant(none.staff._id, "none", "all");
  expect((await as(none.accessToken).get("/api/v1/staff/shifts?date=2027-03-10")).status).toBe(403);
});

it("validates input, organization references and staff status", async () => {
  const { nurse, shift, boss } = await scheduleFixture();
  expect((await boss.post("/api/v1/staff/shifts", { ...shift, endTime: "08:00" })).status).toBe(
    400
  );
  expect((await boss.post("/api/v1/staff/shifts", { ...shift, extra: true })).status).toBe(400);
  expect((await boss.post("/api/v1/staff/shifts", { ...shift, date: "2027-02-30" })).status).toBe(
    400
  );
  expect((await boss.get("/api/v1/staff/shifts?date=2027-03-10&roleIds=nope")).status).toBe(400);
  expect(
    (await boss.patch("/api/v1/staff/shifts/000000000000000000000000", { endTime: "13:00" })).status
  ).toBe(404);
  const foreign = await Location.create({ organizationId: "org-other", name: "Elsewhere" });
  expect(
    (await boss.post("/api/v1/staff/shifts", { ...shift, locationId: String(foreign._id) })).status
  ).toBe(404);
  await StaffMember.updateOne({ _id: nurse.staff._id }, { accountStatus: "pending_onboarding" });
  expect((await boss.post("/api/v1/staff/shifts", shift)).status).toBe(201);
  await StaffMember.updateOne({ _id: nurse.staff._id }, { accountStatus: "deactivated" });
  const inactive = await boss.post("/api/v1/staff/shifts", { ...shift, date: "2027-03-11" });
  expect(inactive.status).toBe(409);
  expect(inactive.body.code).toBe("SHIFT_STAFF_INACTIVE");
});

it("creates open shifts, reports them as coverage gaps and can assign them", async () => {
  const { nurse, shift, boss } = await scheduleFixture();
  const open = await boss.post("/api/v1/staff/shifts", {
    ...shift,
    staffId: null,
    stationName: "Front Desk",
    startTime: "14:00",
    endTime: "20:00",
  });
  expect(open.status).toBe(201);
  await boss.post("/api/v1/staff/shifts", { ...shift, date: "2027-03-11" });
  const coverage = await boss.get("/api/v1/staff/coverage?date=2027-03-10");
  expect(coverage.body.data.map((s: { stationName: string }) => s.stationName)).toEqual([
    "Front Desk",
  ]);
  expect((await boss.get("/api/v1/staff/coverage?date=2027-03-11")).body.data).toEqual([]);
  const assigned = await boss.patch(`/api/v1/staff/shifts/${open.body.data._id}`, {
    staffId: String(nurse.staff._id),
  });
  expect(assigned.status).toBe(200);
  expect((await boss.get("/api/v1/staff/coverage?date=2027-03-10")).body.data).toEqual([]);
});

it("routes static scheduling paths before the staff id route", async () => {
  const { boss } = await scheduleFixture();
  for (const path of ["overview", "onboarding", "providers", "pto-requests"])
    expect((await boss.get(`/api/v1/staff/${path}`)).status).toBe(200);
});
