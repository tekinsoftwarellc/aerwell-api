import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pinClock } from "../../test/appointmentFixture.js";
import { ORG, staffWith } from "../../test/memberFixture.js";
import { as, scheduleFixture } from "../../test/scheduleFixture.js";
import { issueSession } from "../auth/session.service.js";
import { PtoRequest } from "../schedule/schedule.model.js";
import { Notification } from "./notification.model.js";
import { type Notice, notify } from "./notify.js";
import { NotificationPreference, NotificationRule } from "./preference.model.js";

const ses = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {
    send = ses.send;
    destroy() {}
  },
  SendEmailCommand: class {
    constructor(public input: unknown) {}
  },
}));

// Pinned: 2027-03-01 12:00 in Los Angeles, outside the default 21:00-07:00 quiet hours.
beforeEach(() => pinClock());
afterEach(() => vi.useRealTimers());

const PTO = { startDate: "2027-03-10", endDate: "2027-03-11", type: "vacation" };
const inbox = async (token: string, query = "") => {
  const res = await as(token).get(`/api/v1/notifications${query}`);
  expect(res.status).toBe(200);
  return res.body.data;
};
const titles = async (token: string, query = "") =>
  (await inbox(token, query)).items.map((i: { title: string }) => i.title);
const direct = (staffId: unknown, extra: Partial<Notice> = {}): Notice => ({
  organizationId: ORG,
  kind: "pto_requested",
  category: "approvals",
  title: "Direct notice",
  staffIds: [staffId],
  requires: [{ module: "STAFF_RECORDS", level: "view" }],
  ...extra,
});

it("notifies time-off approvers, never the requester, view-only or own-scope staff", async () => {
  const { director, nurse } = await scheduleFixture();
  const viewer = await staffWith({ STAFF_RECORDS: "view" });
  const ownEditor = await staffWith({ STAFF_RECORDS: "edit" }, "own");
  const res = await as(nurse.accessToken).post("/api/v1/staff/pto-requests", PTO);
  expect(res.status).toBe(201);
  const box = await inbox(director.accessToken);
  expect(box.unreadCount).toBe(1);
  expect(box.items).toHaveLength(1);
  expect(box.items[0]).toMatchObject({
    kind: "pto_requested",
    category: "approvals",
    title: "Time off requested: Theresa West · 2027-03-10 to 2027-03-11",
    link: "/staff",
    critical: false,
    readAt: null,
  });
  for (const other of [nurse, viewer, ownEditor])
    expect((await inbox(other.accessToken)).unreadCount).toBe(0);
  const counters = await as(director.accessToken).get("/api/v1/me/counters");
  expect(counters.body.data).toEqual({ unreadNotifications: 1 });
});

it("tells the requester when time off is decided, and not the approver", async () => {
  const { director, nurse } = await scheduleFixture();
  const created = await as(nurse.accessToken).post("/api/v1/staff/pto-requests", PTO);
  const id = created.body.data._id;
  expect(
    (await as(director.accessToken).post(`/api/v1/staff/pto-requests/${id}/deny`, {})).status
  ).toBe(200);
  expect(await titles(nurse.accessToken)).toEqual([
    "Your time off 2027-03-10 to 2027-03-11 was denied",
  ]);
  expect(await titles(director.accessToken)).toEqual([
    "Time off requested: Theresa West · 2027-03-10 to 2027-03-11",
  ]);
});

it("never fails the originating request when a producer throws", async () => {
  const { director, nurse } = await scheduleFixture();
  const spy = vi.spyOn(Notification, "insertMany").mockRejectedValueOnce(new Error("down"));
  const res = await as(nurse.accessToken).post("/api/v1/staff/pto-requests", PTO);
  expect(res.status).toBe(201);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(await PtoRequest.countDocuments({ staffId: nurse.staff._id })).toBe(1);
  expect((await inbox(director.accessToken)).unreadCount).toBe(0);
  spy.mockRestore();
});

it("adds role-rule recipients only through an in-app rule, still behind the permission", async () => {
  const { nurse } = await scheduleFixture();
  const coordinator = await staffWith({ STAFF_RECORDS: "view" });
  const emailOnly = await staffWith({ STAFF_RECORDS: "view" });
  const noAccess = await staffWith({ MEMBER_RECORDS: "view" });
  const ownViewer = await staffWith({ STAFF_RECORDS: "view" }, "own");
  const disabled = await staffWith({ STAFF_RECORDS: "view" });
  const rule = (roleId: unknown, channels: string[]) =>
    NotificationRule.create({
      organizationId: ORG,
      trigger: "time_off_request",
      recipient: { type: "role", id: roleId },
      channels,
    });
  await rule(coordinator.role._id, ["in_app", "email"]);
  await rule(emailOnly.role._id, ["email"]);
  await rule(noAccess.role._id, ["in_app"]);
  await rule(ownViewer.role._id, ["in_app"]);
  await NotificationRule.create({
    organizationId: ORG,
    trigger: "time_off_request",
    recipient: { type: "role", id: disabled.role._id },
    channels: ["in_app"],
    enabled: false,
  });
  await as(nurse.accessToken).post("/api/v1/staff/pto-requests", PTO);
  expect((await inbox(coordinator.accessToken)).unreadCount).toBe(1);
  expect((await inbox(emailOnly.accessToken)).unreadCount).toBe(0);
  for (const other of [noAccess, ownViewer, disabled])
    expect((await inbox(other.accessToken)).unreadCount).toBe(0);
});

it("honours personal in-app switches, always delivers critical alerts, never sends email", async () => {
  const staff = await staffWith({ STAFF_RECORDS: "view" });
  await NotificationPreference.create({
    organizationId: ORG,
    staffId: staff.staff._id,
    matrix: {
      approvals: { in_app: false, push: true, email: true },
      critical_alerts: { in_app: false, push: false, email: true },
    },
    quietHours: { enabled: false, start: "21:00", end: "07:00" },
  });
  expect(await notify(direct(staff.staff._id, { title: "Approval" }))).toBe(0);
  expect(
    await notify(
      direct(staff.staff._id, {
        kind: "critical_lab_result",
        category: "critical_alerts",
        title: "Critical",
      })
    )
  ).toBe(1);
  expect(await notify(direct(staff.staff._id, { category: "system", title: "System" }))).toBe(1);
  const rows = await Notification.find({ recipientStaffId: staff.staff._id })
    .sort({ _id: 1 })
    .lean();
  expect(rows.map((r) => [r.title, r.critical, r.deliveries])).toEqual([
    ["Critical", true, { in_app: "delivered", email: "unconfigured", push: "unconfigured" }],
    ["System", false, { in_app: "delivered", email: "off", push: "off" }],
  ]);
  expect(ses.send).not.toHaveBeenCalled();
});

it("defers delivery through quiet hours instead of dropping it; critical alerts skip the wait", async () => {
  const staff = await staffWith({ STAFF_RECORDS: "view" });
  const id = staff.staff._id;
  // Access tokens are short-lived: mint one at each new pinned time.
  const fresh = async () => (await issueSession(String(id), 0)).accessToken;
  pinClock(new Date("2027-03-02T04:59:00Z")); // 20:59 local: not quiet yet
  await notify(direct(id, { title: "Before quiet" }));
  pinClock(new Date("2027-03-02T06:30:00Z")); // 22:30 local: quiet (default 21:00-07:00)
  await notify(direct(id, { title: "Deferred" }));
  await notify(
    direct(id, { kind: "critical_lab_result", category: "critical_alerts", title: "Critical" })
  );
  expect(await titles(await fresh())).toEqual(["Critical", "Before quiet"]);
  const deferred = await Notification.findOne({ title: "Deferred" }).lean();
  expect(deferred?.deliverAfter.toISOString()).toBe("2027-03-02T15:00:00.000Z"); // 07:00 local
  expect(deferred?.deliveries?.in_app).toBe("deferred");
  // Mark-all during quiet hours must not swallow what the reader has not seen yet.
  await as(await fresh()).post("/api/v1/notifications/read-all");
  pinClock(new Date("2027-03-02T14:59:00Z"));
  expect((await inbox(await fresh())).unreadCount).toBe(0);
  pinClock(new Date("2027-03-02T15:00:00Z"));
  const box = await inbox(await fresh());
  expect(box.unreadCount).toBe(1);
  // Listed in event order (newest event first); only the deferred row is unread.
  expect(
    box.items.map((i: { title: string; readAt: string | null }) => [i.title, !i.readAt])
  ).toEqual([
    ["Critical", false],
    ["Deferred", true],
    ["Before quiet", false],
  ]);
});

it("handles quiet windows that do not wrap past midnight", async () => {
  const staff = await staffWith({ STAFF_RECORDS: "view" });
  await NotificationPreference.create({
    organizationId: ORG,
    staffId: staff.staff._id,
    quietHours: { enabled: true, start: "12:00", end: "13:00" },
  });
  await notify(direct(staff.staff._id, { title: "Noon" })); // 12:00 local, quiet
  const row = await Notification.findOne({ title: "Noon" }).lean();
  expect(row?.deliverAfter.toISOString()).toBe("2027-03-01T21:00:00.000Z");
});

it("pages newest first by cursor, marks one or all read, and never exposes another inbox", async () => {
  const a = await staffWith({ STAFF_RECORDS: "view" });
  const b = await staffWith({ STAFF_RECORDS: "view" });
  for (const n of [0, 1, 2, 3, 4]) await notify(direct(a.staff._id, { title: `n${n}` }));
  await notify(direct(b.staff._id, { title: "theirs" }));
  const first = await inbox(a.accessToken, "?limit=2");
  expect(first.items.map((i: { title: string }) => i.title)).toEqual(["n4", "n3"]);
  expect(first.unreadCount).toBe(5);
  const second = await inbox(a.accessToken, `?limit=2&cursor=${first.nextCursor}`);
  expect(second.items.map((i: { title: string }) => i.title)).toEqual(["n2", "n1"]);
  const last = await inbox(a.accessToken, `?limit=2&cursor=${second.nextCursor}`);
  expect(last.items.map((i: { title: string }) => i.title)).toEqual(["n0"]);
  expect(last.nextCursor).toBeNull();
  const target = first.items[0].id;
  expect((await as(b.accessToken).post(`/api/v1/notifications/${target}/read`)).status).toBe(404);
  const read = await as(a.accessToken).post(`/api/v1/notifications/${target}/read`);
  expect(read.body.data).toEqual({ unreadCount: 4 });
  const readAt = (await Notification.findById(target).lean())?.readAt;
  pinClock(new Date("2027-03-01T20:05:00Z"));
  await as(a.accessToken).post(`/api/v1/notifications/${target}/read`);
  expect((await Notification.findById(target).lean())?.readAt).toEqual(readAt);
  expect(await titles(a.accessToken, "?unread=true")).toEqual(["n3", "n2", "n1", "n0"]);
  expect(await titles(a.accessToken, "?unread=false")).toEqual(["n4", "n3", "n2", "n1", "n0"]);
  const all = await as(a.accessToken).post("/api/v1/notifications/read-all");
  expect(all.body.data).toEqual({ unreadCount: 0 });
  expect((await inbox(b.accessToken)).unreadCount).toBe(1);
  for (const q of ["?limit=0", "?limit=51", "?cursor=nope", "?extra=1"])
    expect((await as(a.accessToken).get(`/api/v1/notifications${q}`)).status).toBe(400);
});

it("skips inactive staff, the actor and duplicate dedupe keys", async () => {
  const a = await staffWith({ STAFF_RECORDS: "view" });
  const gone = await staffWith({ STAFF_RECORDS: "view" });
  const { StaffMember } = await import("../staff/staff.model.js");
  await StaffMember.updateOne({ _id: gone.staff._id }, { accountStatus: "deactivated" });
  const notice = direct(a.staff._id, { dedupeKey: "cert:1" });
  expect(await notify({ ...notice, staffIds: [a.staff._id, gone.staff._id] })).toBe(1);
  expect(await notify(notice)).toBe(0);
  // A batch with one duplicate still writes the others.
  const b = await staffWith({ STAFF_RECORDS: "view" });
  expect(await notify({ ...notice, staffIds: [a.staff._id, b.staff._id] })).toBe(1);
  expect(await notify({ ...direct(a.staff._id), actorId: a.staff._id })).toBe(0);
  expect(await Notification.countDocuments({ recipientStaffId: gone.staff._id })).toBe(0);
});
