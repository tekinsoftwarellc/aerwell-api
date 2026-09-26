import { afterEach, expect, it, vi } from "vitest";
import { as, scheduleFixture } from "../../test/scheduleFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { PtoRequest, Shift } from "./schedule.model.js";

afterEach(() => vi.useRealTimers());
/** 18:00 UTC = 10:00 in Los Angeles on 10 Mar 2027. Pinned before tokens are minted. */
function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-03-10T18:00:00Z"));
  return scheduleFixture();
}

it("refuses time off that starts before today in the organization day", async () => {
  const { nurse } = await fixture();
  const api = as(nurse.accessToken);
  const past = await api.post("/api/v1/staff/pto-requests", {
    startDate: "2027-03-09",
    endDate: "2027-03-12",
    type: "vacation",
  });
  expect(past.status).toBe(422);
  expect(past.body.code).toBe("PTO_IN_PAST");
  const today = await api.post("/api/v1/staff/pto-requests", {
    startDate: "2027-03-10",
    endDate: "2027-03-11",
    type: "vacation",
  });
  expect(today.status).toBe(201);
});

it("keeps already-started shifts assigned when approving leave", async () => {
  const { nurse, shift, boss } = await fixture();
  const worked = await boss.post("/api/v1/staff/shifts", {
    ...shift,
    startTime: "06:00",
    endTime: "08:00",
  });
  const later = await boss.post("/api/v1/staff/shifts", { ...shift, date: "2027-03-11" });
  const created = await as(nurse.accessToken).post("/api/v1/staff/pto-requests", {
    startDate: "2027-03-10",
    endDate: "2027-03-11",
    type: "vacation",
  });
  const detail = await boss.get(`/api/v1/staff/pto-requests/${created.body.data._id}`);
  expect(detail.body.data.affectedShifts.map((s: { _id: string }) => s._id)).toEqual([
    later.body.data._id,
  ]);
  expect(
    (await boss.post(`/api/v1/staff/pto-requests/${created.body.data._id}/approve`)).status
  ).toBe(200);
  expect(String((await Shift.findById(worked.body.data._id))?.staffId)).toBe(
    String(nurse.staff._id)
  );
  expect((await Shift.findById(later.body.data._id))?.staffId).toBeNull();
});

it("opens future shifts and closes pending time off when staff are deactivated", async () => {
  const { nurse, shift, boss } = await fixture();
  // Running at 10:00: stays assigned as history, but a deactivated person is never "on duty".
  const past = await boss.post("/api/v1/staff/shifts", {
    ...shift,
    startTime: "09:00",
    endTime: "11:00",
  });
  const future = await boss.post("/api/v1/staff/shifts", { ...shift, date: "2027-03-12" });
  const pending = await as(nurse.accessToken).post("/api/v1/staff/pto-requests", {
    startDate: "2027-04-01",
    endDate: "2027-04-02",
    type: "vacation",
  });
  const done = await boss.post(`/api/v1/staff/${nurse.staff._id}/deactivate`, {
    reason: "left_org",
  });
  expect(done.status).toBe(200);
  expect(String((await Shift.findById(past.body.data._id))?.staffId)).toBe(String(nurse.staff._id));
  expect((await Shift.findById(future.body.data._id))?.staffId).toBeNull();
  expect((await PtoRequest.findById(pending.body.data._id))?.status).toBe("denied");
  expect(
    await AuditEvent.countDocuments({
      action: "unassigned_for_deactivation",
      targetId: future.body.data._id,
    })
  ).toBe(1);
  expect(
    await AuditEvent.countDocuments({
      action: "denied_for_deactivation",
      targetId: pending.body.data._id,
    })
  ).toBe(1);
  expect((await boss.get("/api/v1/staff/coverage?date=2027-03-12")).body.data).toHaveLength(1);
  const rows = (await boss.get("/api/v1/staff?status=deactivated")).body.data.items;
  expect(rows[0].dutyStatus).toBe("off");
});

it("clears a station name with null", async () => {
  const { shift, boss } = await fixture();
  const created = await boss.post("/api/v1/staff/shifts", { ...shift, stationName: "Front Desk" });
  const cleared = await boss.patch(`/api/v1/staff/shifts/${created.body.data._id}`, {
    stationName: null,
  });
  expect(cleared.status).toBe(200);
  expect((await Shift.findById(created.body.data._id))?.stationName ?? null).toBeNull();
});
