import { afterEach, expect, it, vi } from "vitest";
import { as, scheduleFixture } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { Certification } from "../staff/staff-details.model.js";
import { StaffMember } from "../staff/staff.model.js";

afterEach(() => vi.useRealTimers());

async function fixture() {
  // 20:00 UTC = 12:00 in Los Angeles on 8 Jan 2027.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-08T20:00:00Z"));
  const base = await scheduleFixture();
  const other = await staffFixture(false, 1);
  await StaffMember.updateOne({ _id: other.staff._id }, { firstName: "Olive", lastName: "Other" });
  return { ...base, other };
}
const ids = async (boss: ReturnType<typeof as>, query: string) =>
  (await boss.get(`/api/v1/staff?limit=100&${query}`)).body.data.items.map(
    (s: { _id: string }) => s._id
  );

it("derives on-duty status from shifts that contain now", async () => {
  const { nurse, other, shift, boss } = await fixture();
  await boss.post("/api/v1/staff/shifts", {
    ...shift,
    date: "2027-01-08",
    startTime: "11:00",
    endTime: "13:00",
  });
  await boss.post("/api/v1/staff/shifts", {
    ...shift,
    staffId: String(other.staff._id),
    positionRoleId: String(other.role._id),
    date: "2027-01-08",
    startTime: "13:00",
    endTime: "15:00",
  });
  const onDuty = await ids(boss, "status=on_duty");
  expect(onDuty).toEqual([String(nurse.staff._id)]);
  const rows = (await boss.get("/api/v1/staff?limit=100")).body.data.items;
  const duty = Object.fromEntries(
    rows.map((r: { _id: string; dutyStatus: string }) => [r._id, r.dutyStatus])
  );
  expect(duty[String(nurse.staff._id)]).toBe("on_duty");
  expect(duty[String(other.staff._id)]).toBe("off");
});

it("filters and labels pending PTO on both sides", async () => {
  const { nurse, other, boss } = await fixture();
  await as(nurse.accessToken).post("/api/v1/staff/pto-requests", {
    startDate: "2027-02-01",
    endDate: "2027-02-02",
    type: "vacation",
  });
  const matched = await ids(boss, "flags=pto_requested");
  expect(matched).toEqual([String(nurse.staff._id)]);
  expect(matched).not.toContain(String(other.staff._id));
  const profile = await boss.get(`/api/v1/staff/${nurse.staff._id}`);
  expect(profile.body.data.flags.map((f: { kind: string }) => f.kind)).toContain("pto_requested");
});

it("flags active staff whose role has an upcoming open shift, consistently with the filter", async () => {
  const { nurse, other, shift, boss } = await fixture();
  await boss.post("/api/v1/staff/shifts", { ...shift, staffId: null, date: "2027-01-10" });
  const peer = await staffFixture(false, 2);
  await StaffMember.updateOne(
    { _id: peer.staff._id },
    { roleId: nurse.role._id, accountStatus: "deactivated" }
  );
  const matched = await ids(boss, "flags=open_shift");
  expect(matched).toEqual([String(nurse.staff._id)]);
  const rows = (await boss.get("/api/v1/staff?limit=100&status=active&status=deactivated")).body
    .data.items;
  const flagged = rows
    .filter((r: { flags: { kind: string }[] }) => r.flags.some((f) => f.kind === "open_shift"))
    .map((r: { _id: string }) => r._id);
  expect(flagged).toEqual([String(nurse.staff._id)]);
  expect(flagged).not.toContain(String(other.staff._id));
});

it("uses the organization day for certification renewal windows", async () => {
  const { nurse, other, boss } = await fixture();
  await Certification.create({
    organizationId: "org-test",
    staffId: nurse.staff._id,
    name: "ACLS",
    expirationDate: "2027-03-09",
  });
  await Certification.create({
    organizationId: "org-test",
    staffId: other.staff._id,
    name: "CPR",
    expirationDate: "2027-03-10",
  });
  // 8 Jan + 60 days = 9 Mar: inclusive edge in, the day after out.
  expect(await ids(boss, "flags=certification_renewal")).toEqual([String(nurse.staff._id)]);
});
