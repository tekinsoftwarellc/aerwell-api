import { createHmac } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { bookingWorld, pinClock } from "../../test/appointmentFixture.js";
import { catalogIds, result } from "../../test/clinicalFixture.js";
import { ORG, idOf, memberRow, staffWith } from "../../test/memberFixture.js";
import { app, as } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { Certification } from "../staff/staff-details.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { Notification } from "./notification.model.js";
import { certificationNotices } from "./producers.js";

const email = vi.hoisted(() => vi.fn());
vi.mock("../../common/services/email.service.js", () => ({
  sendEmail: email,
  emailConfigured: () => true,
}));
beforeEach(() => pinClock());
afterEach(() => vi.useRealTimers());

const titlesOf = async (staffId: unknown) =>
  (await Notification.find({ recipientStaffId: staffId }).sort({ _id: 1 }).lean()).map(
    (r) => r.title
  );
const noMemberName = async (member: { firstName: string; lastName: string }) => {
  const all = JSON.stringify(await Notification.find().lean());
  expect(all).not.toContain(member.firstName);
  expect(all).not.toContain(member.lastName);
};

it("tells the provider about bookings, moves and cancellations by others, without member names", async () => {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-essential"]);
  const booked = await w.api.post(
    "/api/v1/appointments",
    w.booking(member._id, "clinician-telehealth-visit")
  );
  expect(booked.status).toBe(201);
  const id = booked.body.data.appointment._id;
  // A replayed idempotent booking is not a second event.
  const key = { idempotencyKey: "same-key-1" };
  const first = await w.api.post("/api/v1/appointments", {
    ...w.booking(member._id, "clinician-telehealth-visit", "13:00"),
    ...key,
  });
  const replay = await w.api.post("/api/v1/appointments", {
    ...w.booking(member._id, "clinician-telehealth-visit", "13:00"),
    ...key,
  });
  expect([first.status, replay.body.data.replayed]).toEqual([201, true]);
  await w.api.post(`/api/v1/appointments/${id}/reschedule`, {
    startAt: new Date("2027-03-10T18:00:00.000Z").toISOString(),
  });
  await w.api.post(`/api/v1/appointments/${id}/cancel`, { reason: "Member asked" });
  expect(await titlesOf(w.provider.staff._id)).toEqual([
    "New appointment: Aerwell Clinician Telehealth Visit · Mar 10, 9:00 AM",
    "New appointment: Aerwell Clinician Telehealth Visit · Mar 10, 1:00 PM",
    "Appointment moved: Aerwell Clinician Telehealth Visit · Mar 10, 10:00 AM",
    "Appointment cancelled: Aerwell Clinician Telehealth Visit · Mar 10, 10:00 AM",
  ]);
  expect(await titlesOf(w.director.staff._id)).toEqual([]);
  // The provider acting on their own booking is not told about it.
  await as(w.provider.accessToken).post(
    "/api/v1/appointments",
    w.booking(member._id, "clinician-telehealth-visit", "15:00")
  );
  expect(await titlesOf(w.provider.staff._id)).toHaveLength(4);
  await noMemberName(member);
});

it("raises a flag notice on a no-show and on a staff-raised flag, to assigned clinicians only", async () => {
  const w = await bookingWorld();
  const nurse = await staffWith({ MEMBER_RECORDS: "view" }, "own");
  const stranger = await staffWith({ MEMBER_RECORDS: "view" }, "own");
  const frontDesk = await staffWith({ STAFF_RECORDS: "view" });
  const member = await w.member(["aerwell-essential"], {
    assignedClinicianIds: [nurse.staff._id, frontDesk.staff._id],
  });
  const booked = await w.api.post(
    "/api/v1/appointments",
    w.booking(member._id, "clinician-telehealth-visit")
  );
  const id = booked.body.data.appointment._id;
  expect(
    (await w.api.patch(`/api/v1/appointments/${id}/status`, { status: "no_show" })).status
  ).toBe(200);
  const flag = await w.api.post(`/api/v1/members/${idOf(member)}/flags`, {
    category: "allergy",
    title: `Penicillin allergy for ${member.firstName}`,
  });
  expect(flag.status).toBe(201);
  expect(await titlesOf(nurse.staff._id)).toEqual([
    "Member flag raised: Attendance",
    "Member flag raised: Allergy",
  ]);
  expect(await titlesOf(stranger.staff._id)).toEqual([]);
  expect(await titlesOf(frontDesk.staff._id)).toEqual([]); // no MEMBER_RECORDS
  const row = await Notification.findOne({ recipientStaffId: nurse.staff._id }).lean();
  expect(row?.link).toBe(`/members/${idOf(member)}`);
  await noMemberName(member);
});

it("asks assigned clinicians (or else LABS_SCANS editors) to review new labs and scans", async () => {
  const ids = await catalogIds();
  const admin = await staffFixture(true);
  const clinician = await staffWith({ MEMBER_RECORDS: "view", LABS_SCANS: "view" }, "own");
  const editor = await staffWith({ MEMBER_RECORDS: "view", LABS_SCANS: "edit" });
  const noLabs = await staffWith({ MEMBER_RECORDS: "view" });
  // LABS_SCANS editor for everyone, but MEMBER_RECORDS own: only assigned members.
  const ownRecords = await staffWith({ MEMBER_RECORDS: "view", LABS_SCANS: "edit" });
  await StaffMember.updateOne(
    { _id: ownRecords.staff._id },
    { $set: { permissionOverrides: [{ module: "MEMBER_RECORDS", level: "view", scope: "own" }] } }
  );
  const assigned = await memberRow({
    sex: "female",
    assignedClinicianIds: [clinician.staff._id, noLabs.staff._id],
  });
  const unassigned = await memberRow({ sex: "male" });
  const post = (member: typeof assigned, path: string, body: object) =>
    as(admin.accessToken).post(`/api/v1/members/${idOf(member)}${path}`, body);
  const panel = { drawnAt: "2027-02-20T16:00:00.000Z", results: [result(ids["tsh"], 2)] };
  expect((await post(assigned, "/lab-panels", panel)).status).toBe(201);
  expect((await post(unassigned, "/lab-panels", panel)).status).toBe(201);
  const scan = { performedAt: "2027-02-20T16:00:00.000Z", metrics: { bodyFatPct: 25 } };
  expect((await post(assigned, "/scans", scan)).status).toBe(201);
  expect(await titlesOf(clinician.staff._id)).toEqual([
    "New lab results to review",
    "New DEXA scan to review",
  ]);
  expect(await titlesOf(editor.staff._id)).toEqual(["New lab results to review"]);
  expect(await titlesOf(noLabs.staff._id)).toEqual([]);
  expect(await titlesOf(ownRecords.staff._id)).toEqual([]);
  expect(await titlesOf(admin.staff._id)).toEqual([]); // the actor
  await noMemberName(assigned);
});

it("notifies BILLING readers of a failed payment from the Stripe webhook, once per event", async () => {
  const SECRET = "whsec_test_synthetic_local_only";
  env.STRIPE_WEBHOOK_SECRET = SECRET;
  try {
    const billing = await staffWith({ MEMBER_RECORDS: "view", BILLING: "view" });
    const none = await staffWith({ MEMBER_RECORDS: "view" });
    const member = await memberRow({ processorCustomerId: "cus_synthetic" });
    const t = Math.floor(Date.now() / 1000);
    const event = (type: string, eventId: string) =>
      JSON.stringify({
        id: eventId,
        type,
        created: t,
        data: {
          object: {
            id: `in_${eventId}`,
            customer: "cus_synthetic",
            amount_due: 30000,
            amount_paid: 0,
            currency: "usd",
            created: t,
          },
        },
      });
    const deliver = (raw: string) =>
      request(app)
        .post("/api/v1/webhooks/stripe")
        .set("content-type", "application/json")
        .set(
          "stripe-signature",
          `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex")}`
        )
        .send(raw);
    const failed = event("invoice.payment_failed", "evt_failed");
    expect((await deliver(failed)).status).toBe(200);
    expect((await deliver(failed)).status).toBe(200); // duplicate delivery
    expect((await deliver(event("invoice.paid", "evt_paid"))).status).toBe(200);
    expect(await titlesOf(billing.staff._id)).toEqual(["A membership payment failed"]);
    expect(await titlesOf(none.staff._id)).toEqual([]);
    await noMemberName(member);
  } finally {
    env.STRIPE_WEBHOOK_SECRET = undefined;
  }
});

it("tells staff managers when an invitation is accepted", async () => {
  const master = await staffFixture(false, 0);
  const viewer = await staffWith({ STAFF_RECORDS: "view" });
  const created = await as(master.accessToken).post("/api/v1/staff", {
    firstName: "New",
    lastName: "Clinician",
    email: "new@example.invalid",
    roleId: String(master.role._id),
    employmentType: "full_time",
  });
  expect(created.status).toBe(201);
  const token = email.mock.calls[0]?.[0].text.split("#token=")[1];
  const accepted = await request(app).post("/api/v1/auth/accept-invite").send({
    token,
    password: "Invitation-passphrase!9",
    firstName: "Nia",
    lastName: "Clinician",
  });
  expect(accepted.status).toBe(200);
  expect(await titlesOf(master.staff._id)).toEqual(["Nia Clinician accepted their invitation"]);
  expect(await titlesOf(viewer.staff._id)).toEqual([]);
});

it("reminds STAFF_RECORDS masters once about certifications expiring within 60 days", async () => {
  const master = await staffFixture(false, 0);
  const editor = await staffWith({ STAFF_RECORDS: "edit" });
  const holder = await staffWith({ STAFF_RECORDS: "view" });
  await StaffMember.updateOne({ _id: holder.staff._id }, { firstName: "Ana", lastName: "Ruiz" });
  const cert = (name: string, expirationDate: string) =>
    Certification.create({ organizationId: ORG, staffId: holder.staff._id, name, expirationDate });
  await cert("BLS", "2027-04-30"); // 60 days after 2027-03-01: inside
  await cert("ACLS", "2027-05-01"); // 61 days: outside
  await cert("PALS", "2027-02-01"); // already expired: still due
  expect(await certificationNotices(ORG)).toBe(2);
  expect(await certificationNotices(ORG)).toBe(0);
  expect(await titlesOf(master.staff._id)).toEqual([
    "Certification expiring: Ana Ruiz · PALS on 2027-02-01",
    "Certification expiring: Ana Ruiz · BLS on 2027-04-30",
  ]);
  expect(await titlesOf(editor.staff._id)).toEqual([]);
});

it("review H1: a producer's own lookups failing never fail the committed request", async () => {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-essential"]);
  const { Service } = await import("../service/service.model.js");
  const spy = vi.spyOn(Service, "findById").mockImplementation(() => {
    throw new Error("mongo down");
  });
  try {
    const res = await w.api.post(
      "/api/v1/appointments",
      w.booking(member._id, "clinician-telehealth-visit")
    );
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
  const staffSpy = vi.spyOn(StaffMember, "findById").mockImplementation(() => {
    throw new Error("mongo down");
  });
  try {
    const nurse = await staffWith({ STAFF_RECORDS: "view" });
    const pto = await as(nurse.accessToken).post("/api/v1/staff/pto-requests", {
      startDate: "2027-03-10",
      endDate: "2027-03-10",
      type: "sick",
    });
    expect(pto.status).toBe(201);
  } finally {
    staffSpy.mockRestore();
  }
});

it("review M: falls back to the audience when no assigned clinician can receive it", async () => {
  const ids = await catalogIds();
  const admin = await staffFixture(true);
  const coach = await staffWith({ MEMBER_RECORDS: "view" }); // assigned, but no LABS_SCANS
  const editor = await staffWith({ MEMBER_RECORDS: "view", LABS_SCANS: "edit" });
  const member = await memberRow({ sex: "female", assignedClinicianIds: [coach.staff._id] });
  await as(admin.accessToken).post(`/api/v1/members/${idOf(member)}/lab-panels`, {
    drawnAt: "2027-02-20T16:00:00.000Z",
    results: [result(ids["tsh"], 2)],
  });
  expect(await titlesOf(editor.staff._id)).toEqual(["New lab results to review"]);
  expect(await titlesOf(coach.staff._id)).toEqual([]);
});

it("review M: cancelling an assessment tells each component's provider; no-show skips the actor", async () => {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-continuum"]);
  const opened = await w.api.post("/api/v1/assessment-episodes", {
    memberId: String(member._id),
    bundleServiceId: w.service("advanced-assessment"),
    locationId: String(w.vegas._id),
  });
  const episodeId = opened.body.data.episode._id;
  const booked = await w.api.post("/api/v1/appointments", {
    ...w.booking(member._id, "dexa-scan", "09:00"),
    episodeId,
  });
  expect(booked.status).toBe(201);
  await w.api.post(`/api/v1/assessment-episodes/${episodeId}/cancel`, { reason: "Moved" });
  expect(await titlesOf(w.provider.staff._id)).toEqual([
    "New appointment: DEXA Scan · Mar 10, 9:00 AM",
    "Appointment cancelled: DEXA Scan · Mar 10, 9:00 AM",
  ]);
  // The provider marks their own no-show: they are not told about their own flag.
  const own = await w.api.post(
    "/api/v1/appointments",
    w.booking(member._id, "clinician-telehealth-visit", "13:00")
  );
  await as(w.provider.accessToken).patch(
    `/api/v1/appointments/${own.body.data.appointment._id}/status`,
    { status: "no_show" }
  );
  expect((await titlesOf(w.provider.staff._id)).filter((t) => t.startsWith("Member flag"))).toEqual(
    []
  );
});
