import { expect, it } from "vitest";
import { as, grant, scheduleFixture } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { PtoBalance, Shift } from "./schedule.model.js";

const request = (startDate: string, endDate: string, type = "vacation") => ({
  startDate,
  endDate,
  type,
  note: "Family visit",
});

it("does not deduct pending PTO, forbids self approval, deducts approved and blocks shifts", async () => {
  const { director, nurse, shift, boss } = await scheduleFixture();
  const nurseApi = as(nurse.accessToken);
  const created = await nurseApi.post(
    "/api/v1/staff/pto-requests",
    request("2027-03-10", "2027-03-12")
  );
  expect(created.status).toBe(201);
  expect(created.body.data).toMatchObject({
    days: 3,
    status: "pending",
    staffId: String(nurse.staff._id),
  });
  const id = created.body.data._id;
  const detail = await boss.get(`/api/v1/staff/pto-requests/${id}`);
  expect(detail.body.data).toMatchObject({
    balanceBefore: 15,
    balanceAfter: 12,
    coverageConflicts: [],
  });
  expect(
    (await boss.get(`/api/v1/staff/${nurse.staff._id}/time-off?year=2027`)).body.data.balance
  ).toMatchObject({ usedDays: 0, remainingDays: 15 });
  // A director's own request cannot be approved by that director.
  const own = await boss.post("/api/v1/staff/pto-requests", request("2027-05-03", "2027-05-04"));
  const self = await boss.post(`/api/v1/staff/pto-requests/${own.body.data._id}/approve`);
  expect(self.status).toBe(403);
  // View-only staff cannot decide.
  expect((await nurseApi.post(`/api/v1/staff/pto-requests/${id}/approve`)).status).toBe(403);
  expect((await boss.post(`/api/v1/staff/pto-requests/${id}/approve`)).status).toBe(200);
  expect((await boss.post("/api/v1/staff/shifts", shift)).body.code).toBe("SHIFT_DURING_PTO");
  expect((await boss.post("/api/v1/staff/shifts", { ...shift, date: "2027-03-13" })).status).toBe(
    201
  );
  const timeOff = await boss.get(`/api/v1/staff/${nurse.staff._id}/time-off?year=2027`);
  expect(timeOff.body.data.balance).toMatchObject({
    allowanceDays: 15,
    usedDays: 3,
    remainingDays: 12,
  });
  const after = await boss.get(`/api/v1/staff/pto-requests/${id}`);
  expect(after.body.data).toMatchObject({
    status: "approved",
    balanceBefore: 15,
    balanceAfter: 12,
  });
  const again = await boss.post(`/api/v1/staff/pto-requests/${id}/deny`);
  expect(again.status).toBe(409);
  expect(again.body.code).toBe("PTO_ALREADY_DECIDED");
  expect(String(director.staff._id)).not.toBe(String(nurse.staff._id));
});

it("reads the organization allowance live instead of freezing it at first approval", async () => {
  const { nurse, boss } = await scheduleFixture();
  const created = await as(nurse.accessToken).post(
    "/api/v1/staff/pto-requests",
    request("2027-03-10", "2027-03-12")
  );
  await boss.post(`/api/v1/staff/pto-requests/${created.body.data._id}/approve`);
  const settings = await boss.patch("/api/v1/settings/organization/regional", {
    ptoAllowanceDays: 20,
  });
  expect(settings.status).toBe(200);
  expect(
    (await boss.patch("/api/v1/settings/organization/regional", { ptoAllowanceDays: -1 })).status
  ).toBe(400);
  const timeOff = await boss.get(`/api/v1/staff/${nurse.staff._id}/time-off?year=2027`);
  expect(timeOff.body.data.balance).toMatchObject({
    allowanceDays: 20,
    usedDays: 3,
    remainingDays: 17,
  });
  // A per-staff override still wins over the organization default.
  await PtoBalance.updateOne({ staffId: nurse.staff._id, year: 2027 }, { allowanceDays: 10 });
  expect(
    (await boss.get(`/api/v1/staff/${nurse.staff._id}/time-off?year=2027`)).body.data.balance
  ).toMatchObject({ allowanceDays: 10, remainingDays: 7 });
});

it("splits balances across years and refuses approvals beyond the allowance", async () => {
  const { nurse, boss } = await scheduleFixture();
  const nurseApi = as(nurse.accessToken);
  const split = await nurseApi.post(
    "/api/v1/staff/pto-requests",
    request("2027-12-30", "2028-01-02", "personal")
  );
  expect(split.body.data.days).toBe(4);
  expect(
    (await boss.post(`/api/v1/staff/pto-requests/${split.body.data._id}/approve`)).status
  ).toBe(200);
  const y2027 = (await boss.get(`/api/v1/staff/${nurse.staff._id}/time-off?year=2027`)).body.data;
  const y2028 = (await boss.get(`/api/v1/staff/${nurse.staff._id}/time-off?year=2028`)).body.data;
  expect([y2027.balance.usedDays, y2028.balance.usedDays]).toEqual([2, 2]);
  const long = await nurseApi.post(
    "/api/v1/staff/pto-requests",
    request("2027-06-01", "2027-06-14")
  );
  expect(long.body.data.days).toBe(14);
  const refused = await boss.post(`/api/v1/staff/pto-requests/${long.body.data._id}/approve`);
  expect(refused.status).toBe(409);
  expect(refused.body.code).toBe("PTO_BALANCE_EXCEEDED");
  expect(
    (await boss.get(`/api/v1/staff/pto-requests/${long.body.data._id}`)).body.data.status
  ).toBe("pending");
});

it("validates requests and rejects overlapping pending or approved time off", async () => {
  const { nurse } = await scheduleFixture();
  const nurseApi = as(nurse.accessToken);
  expect(
    (await nurseApi.post("/api/v1/staff/pto-requests", request("2027-03-12", "2027-03-10"))).status
  ).toBe(400);
  expect(
    (
      await nurseApi.post(
        "/api/v1/staff/pto-requests",
        request("2027-03-10", "2027-03-12", "sabbatical")
      )
    ).status
  ).toBe(400);
  expect(
    (
      await nurseApi.post("/api/v1/staff/pto-requests", {
        ...request("2027-03-10", "2027-03-10"),
        staffId: "x",
      })
    ).status
  ).toBe(400);
  expect(
    (await nurseApi.post("/api/v1/staff/pto-requests", request("2027-03-10", "2027-03-12", "sick")))
      .status
  ).toBe(201);
  const overlap = await nurseApi.post(
    "/api/v1/staff/pto-requests",
    request("2027-03-12", "2027-03-14")
  );
  expect(overlap.status).toBe(409);
  expect(overlap.body.code).toBe("PTO_OVERLAP");
});

it("lets any signed-in staff member request their own time off", async () => {
  const { boss } = await scheduleFixture();
  const noStaffAccess = await staffFixture(false, 1);
  await grant(noStaffAccess.staff._id, "none", "all");
  const api = as(noStaffAccess.accessToken);
  expect(
    (await api.post("/api/v1/staff/pto-requests", request("2027-04-01", "2027-04-02"))).status
  ).toBe(201);
  expect((await api.get("/api/v1/staff/pto-requests")).status).toBe(403);
  expect((await boss.get("/api/v1/staff/pto-requests?status=pending")).body.data).toHaveLength(1);
});

it("filters by status on both sides, sorts by start date and honors own scope", async () => {
  const { director, nurse, boss } = await scheduleFixture();
  const nurseApi = as(nurse.accessToken);
  // Created latest-first so creation order is the wrong answer.
  const late = await nurseApi.post(
    "/api/v1/staff/pto-requests",
    request("2027-09-01", "2027-09-02")
  );
  const early = await nurseApi.post(
    "/api/v1/staff/pto-requests",
    request("2027-02-01", "2027-02-02")
  );
  await boss.post("/api/v1/staff/pto-requests", request("2027-05-01", "2027-05-01"));
  await boss.post(`/api/v1/staff/pto-requests/${early.body.data._id}/deny`, { reason: "Coverage" });
  const ids = async (query: string) =>
    (await boss.get(`/api/v1/staff/pto-requests${query}`)).body.data.map(
      (p: { _id: string }) => p._id
    );
  const all = await ids("");
  expect(all).toHaveLength(3);
  expect(all[0]).toBe(early.body.data._id);
  expect(all[2]).toBe(late.body.data._id);
  expect(await ids("?status=denied")).toEqual([early.body.data._id]);
  expect(await ids("?status=pending")).not.toContain(early.body.data._id);
  expect((await ids("?status=pending")).length).toBe(2);
  const denied = await boss.get(`/api/v1/staff/pto-requests/${early.body.data._id}`);
  expect(denied.body.data).toMatchObject({ status: "denied", reason: "Coverage" });
  await grant(nurse.staff._id, "view", "own");
  const mine = (await nurseApi.get("/api/v1/staff/pto-requests")).body.data;
  expect(mine.map((p: { staffId: { _id: string } }) => p.staffId._id)).toEqual([
    String(nurse.staff._id),
    String(nurse.staff._id),
  ]);
  const bossRequest = all.find(
    (id: string) => id !== early.body.data._id && id !== late.body.data._id
  );
  expect((await nurseApi.get(`/api/v1/staff/pto-requests/${bossRequest}`)).status).toBe(404);
  expect(String(director.staff._id)).toBeTruthy();
});

it("turns assigned shifts inside approved time off into audited open shifts", async () => {
  const { nurse, shift, boss } = await scheduleFixture();
  const inside = await boss.post("/api/v1/staff/shifts", shift);
  const outside = await boss.post("/api/v1/staff/shifts", { ...shift, date: "2027-03-20" });
  const created = await as(nurse.accessToken).post(
    "/api/v1/staff/pto-requests",
    request("2027-03-09", "2027-03-11")
  );
  const detail = await boss.get(`/api/v1/staff/pto-requests/${created.body.data._id}`);
  expect(detail.body.data.affectedShifts.map((s: { _id: string }) => s._id)).toEqual([
    inside.body.data._id,
  ]);
  await boss.post(`/api/v1/staff/pto-requests/${created.body.data._id}/approve`);
  expect((await Shift.findById(inside.body.data._id))?.staffId).toBeNull();
  expect(String((await Shift.findById(outside.body.data._id))?.staffId)).toBe(
    String(nurse.staff._id)
  );
  expect(
    await AuditEvent.countDocuments({
      action: "unassigned_for_pto",
      targetId: inside.body.data._id,
    })
  ).toBe(1);
  expect((await boss.get("/api/v1/staff/coverage?date=2027-03-10")).body.data).toHaveLength(1);
});

it("keeps approval and a concurrent shift write consistent", async () => {
  const { nurse, shift, boss } = await scheduleFixture();
  const created = await as(nurse.accessToken).post(
    "/api/v1/staff/pto-requests",
    request("2027-03-10", "2027-03-10")
  );
  const [approval, write] = await Promise.all([
    boss.post(`/api/v1/staff/pto-requests/${created.body.data._id}/approve`),
    boss.post("/api/v1/staff/shifts", shift),
  ]);
  expect(approval.status).toBe(200);
  // Either the shift was blocked, or it landed first and approval opened it.
  if (write.status === 201) expect((await Shift.findById(write.body.data._id))?.staffId).toBeNull();
  else expect(write.body.code).toBe("SHIFT_DURING_PTO");
  expect(await Shift.countDocuments({ staffId: nurse.staff._id, date: "2027-03-10" })).toBe(0);
});
