import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DAY, at, bookingWorld, pinClock, shiftFor } from "../../test/appointmentFixture.js";
import { as } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { Member, MemberFlag } from "../member/member.model.js";
import { Service } from "../service/service.model.js";
import { AllowanceLedgerEntry } from "./appointment.model.js";

beforeEach(() => pinClock());
afterEach(() => vi.useRealTimers());

async function booked(
  w: Awaited<ReturnType<typeof bookingWorld>>,
  plans: string[],
  slug: string,
  time = "09:00"
) {
  const member = await w.member(plans);
  const res = await w.api.post("/api/v1/appointments", w.booking(member._id, slug, time));
  expect(res.status).toBe(201);
  return { member, id: res.body.data.appointment._id as string };
}
const ledgerOf = async (id: string) =>
  AllowanceLedgerEntry.find({ appointmentId: id }).sort({ createdAt: 1, _id: 1 }).lean();

it("walks only valid transitions; completing consumes the unit once and stamps the last visit", async () => {
  const w = await bookingWorld();
  const { member, id } = await booked(w, ["aerwell-essential"], "clinician-telehealth-visit");
  const status = (s: string) => w.api.patch(`/api/v1/appointments/${id}/status`, { status: s });
  const bad = await status("completed");
  expect(bad.status).toBe(422);
  expect(bad.body.code).toBe("INVALID_STATUS_TRANSITION");
  expect((await status("cancelled")).status).toBe(400); // cancel has its own route
  expect((await status("confirmed")).body.data.status).toBe("confirmed");
  expect((await status("checked_in")).body.data.status).toBe("checked_in");
  const done = await status("completed");
  expect(done.body.data.status).toBe("completed");
  expect(done.body.data.statusHistory.map((h: { status: string }) => h.status)).toEqual([
    "booked",
    "confirmed",
    "checked_in",
    "completed",
  ]);
  expect((await status("completed")).body.code).toBe("INVALID_STATUS_TRANSITION");
  expect((await status("no_show")).body.code).toBe("INVALID_STATUS_TRANSITION");
  const rows = await ledgerOf(id);
  expect(rows.map((r) => r.status)).toEqual(["consumed"]);
  expect(rows[0]?.events.map((e) => e.status)).toEqual(["reserved", "consumed"]);
  expect((await Member.findById(member._id).lean())?.lastVisitAt?.toISOString()).toBe(
    at(DAY, "09:00").toISOString()
  );
  const detail = await w.api.get(`/api/v1/appointments/${id}`);
  expect(detail.body.data).toMatchObject({ visitsThisMonth: 1, allowedTransitions: [] });
});

it("a no-show forfeits the unit and raises an urgent attendance flag", async () => {
  const w = await bookingWorld();
  const { member, id } = await booked(w, ["aerwell-essential"], "clinician-telehealth-visit");
  const res = await w.api.patch(`/api/v1/appointments/${id}/status`, { status: "no_show" });
  expect(res.body.data.status).toBe("no_show");
  expect((await ledgerOf(id)).map((r) => r.status)).toEqual(["consumed"]);
  const flag = await MemberFlag.findOne({ memberId: member._id }).lean();
  expect(flag).toMatchObject({
    category: "attendance",
    severity: "urgent",
    raisedBy: "system",
    title: "Missed Appointment - No Show",
  });
});

// NOW is 2027-03-01 12:00 PST; SOON (next morning) is inside a 24 h window, DAY is not.
const SOON = "2027-03-02";
async function bookSoon(
  w: Awaited<ReturnType<typeof bookingWorld>>,
  plans: string[],
  slug: string,
  time: string
) {
  const member = await w.member(plans);
  const res = await w.api.post("/api/v1/appointments", {
    ...w.booking(member._id, slug),
    startAt: at(SOON, time).toISOString(),
  });
  expect(res.status).toBe(201);
  return res.body.data.appointment._id as string;
}

it("cancels outside the window with a release; inside it records the fee or forfeits the unit", async () => {
  const w = await bookingWorld();
  await shiftFor(w.provider.staff._id, w.vegas._id, SOON);
  await Service.updateMany(
    { _id: { $in: [w.service("clinician-telehealth-visit"), w.service("dexa-scan")] } },
    { lateCancellationFee: { enabled: true, amountCents: 5000, windowHours: 24 } }
  );
  const early = await booked(w, ["aerwell-essential"], "clinician-telehealth-visit");
  const preview = await w.api.get(`/api/v1/appointments/${early.id}`);
  expect(preview.body.data.cancellationPreview).toMatchObject({
    late: false,
    feeCents: 0,
    allowanceHeld: true,
  });
  const res = await w.api.post(`/api/v1/appointments/${early.id}/cancel`, { reason: "Travel" });
  expect(res.body.data).toMatchObject({
    status: "cancelled",
    amountDueCents: 0,
    cancellation: { late: false, feeCents: 0, allowance: "released" },
  });
  expect((await ledgerOf(early.id)).map((r) => [r.status, r.holding])).toEqual([
    ["released", false],
  ]);
  const twice = await w.api.post(`/api/v1/appointments/${early.id}/cancel`, { reason: "again" });
  expect(twice.body.code).toBe("INVALID_STATUS_TRANSITION");
  // Inside the window: a paid booking records the fee as amount due (payments unconfigured).
  const paid = await bookSoon(w, ["aerwell-essential"], "dexa-scan", "09:00");
  const late = await w.api.post(`/api/v1/appointments/${paid}/cancel`, { reason: "Sick" });
  expect(late.body.data).toMatchObject({
    amountDueCents: 5000,
    paymentStatus: "unconfigured",
    cancellation: { late: true, feeCents: 5000, allowance: "none" },
  });
  // An allowance booking forfeits its unit instead of a fee.
  const covered = await bookSoon(w, ["aerwell-essential"], "clinician-telehealth-visit", "11:00");
  const forfeited = await w.api.post(`/api/v1/appointments/${covered}/cancel`, { reason: "Late" });
  expect(forfeited.body.data.cancellation).toMatchObject({
    late: true,
    feeCents: 0,
    allowance: "forfeited",
  });
  expect((await ledgerOf(covered)).map((r) => r.status)).toEqual(["consumed"]);
});

it("waiving a late fee needs Appointments master and releases the unit", async () => {
  const w = await bookingWorld();
  await shiftFor(w.provider.staff._id, w.vegas._id, SOON);
  await Service.updateOne(
    { _id: w.service("clinician-telehealth-visit") },
    { lateCancellationFee: { enabled: true, amountCents: 5000, windowHours: 48 } }
  );
  const id = await bookSoon(w, ["aerwell-essential"], "clinician-telehealth-visit", "09:00");
  const editor = await staffFixture(false, 4); // front desk: APPOINTMENTS edit, not master
  const denied = await as(editor.accessToken).post(`/api/v1/appointments/${id}/cancel`, {
    reason: "Waive",
    waiveFee: true,
  });
  expect(denied.status).toBe(403);
  expect(denied.body.code).toBe("WAIVE_REQUIRES_MASTER");
  const waived = await w.api.post(`/api/v1/appointments/${id}/cancel`, {
    reason: "Waive",
    waiveFee: true,
  });
  expect(waived.body.data.cancellation).toMatchObject({
    late: true,
    feeWaived: true,
    feeCents: 0,
    allowance: "released",
  });
  expect((await ledgerOf(id)).map((r) => r.status)).toEqual(["released"]);
});

it("reschedules atomically: re-quotes into the new benefit period and moves the reservation", async () => {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-essential"]);
  // Use both current-period units (anniversary year from 2027-01-15).
  const a = await w.api.post(
    "/api/v1/appointments",
    w.booking(member._id, "clinician-telehealth-visit")
  );
  await w.api.post(
    "/api/v1/appointments",
    w.booking(member._id, "clinician-telehealth-visit", "11:00")
  );
  const id = a.body.data.appointment._id;
  // Move into the next anniversary year: its own allowance applies.
  await shiftFor(w.provider.staff._id, w.vegas._id, "2028-01-20");
  const nextYear = at("2028-01-20", "09:00").toISOString();
  const q = await w.quoteOf({
    ...w.booking(member._id, "clinician-telehealth-visit"),
    startAt: nextYear,
    appointmentId: id,
  });
  expect(q.body.data.allowance).toMatchObject({
    usedBefore: 0,
    periodStart: "2028-01-15T08:00:00.000Z",
  });
  const moved = await w.api.post(`/api/v1/appointments/${id}/reschedule`, {
    startAt: nextYear,
    expectedQuote: { finalCents: q.body.data.finalCents, ruleVersion: q.body.data.ruleVersion },
  });
  expect(moved.status).toBe(200);
  expect(moved.body.data.startAt).toBe(nextYear);
  const rows = await ledgerOf(id);
  expect(rows.map((r) => [r.status, r.periodStart.toISOString()])).toEqual([
    ["released", "2027-01-15T08:00:00.000Z"],
    ["reserved", "2028-01-15T08:00:00.000Z"],
  ]);
  // Freed current-year unit is bookable again at $0.
  const again = await w.quoteOf(w.booking(member._id, "clinician-telehealth-visit", "13:00"));
  expect(again.body.data).toMatchObject({ decision: "allowance", finalCents: 0 });
  // A slot conflict aborts the reschedule and keeps the original reservation.
  const other = await w.member(["aerwell-essential"]);
  await w.api.post("/api/v1/appointments", {
    ...w.booking(other._id, "clinician-telehealth-visit"),
    startAt: at("2028-01-20", "11:00").toISOString(),
  });
  const clash = await w.api.post(`/api/v1/appointments/${id}/reschedule`, {
    startAt: at("2028-01-20", "11:00").toISOString(),
  });
  expect(clash.body.code).toBe("SLOT_UNAVAILABLE");
  expect((await ledgerOf(id)).map((r) => r.status)).toEqual(["released", "reserved"]);
});

it("reschedule to a place outside the market is refused atomically", async () => {
  const w = await bookingWorld();
  const { id } = await booked(w, ["aerwell-essential"], "dexa-scan");
  await Service.updateOne({ _id: w.service("dexa-scan") }, { $set: { marketIds: [] } });
  const res = await w.api.post(`/api/v1/appointments/${id}/reschedule`, {
    startAt: at(DAY, "11:00").toISOString(),
  });
  expect(res.status).toBe(422);
  expect(res.body.code).toBe("MARKET_UNAVAILABLE");
  const detail = await w.api.get(`/api/v1/appointments/${id}`);
  expect(detail.body.data.startAt).toBe(at(DAY, "09:00").toISOString());
});

it("review M2: cancelling after check-in forfeits the unit even with no late-fee policy", async () => {
  const w = await bookingWorld();
  const { id } = await booked(w, ["aerwell-essential"], "clinician-telehealth-visit");
  await w.api.patch(`/api/v1/appointments/${id}/status`, { status: "checked_in" });
  const res = await w.api.post(`/api/v1/appointments/${id}/cancel`, {
    reason: "Left",
    waiveFee: true,
  });
  expect(res.body.data.cancellation.allowance).toBe("forfeited");
  expect((await ledgerOf(id)).map((r) => r.status)).toEqual(["consumed"]);
});

it("review H2: units reserved under a quarterly period still count after the benefit becomes yearly", async () => {
  const w = await bookingWorld();
  const { MembershipPlan } = await import("../catalog/catalog.model.js");
  const plan = w.plans.get("aerwell-essential");
  const setUnit = (unit: string) =>
    MembershipPlan.updateOne(
      { _id: plan?._id },
      {
        $set: {
          benefits: (plan?.benefits ?? []).map((b) =>
            String(b.serviceId) === w.service("clinician-telehealth-visit")
              ? { ...b, period: { unit, anchor: "anniversary", rollover: "none" } }
              : b
          ),
        },
      }
    );
  await setUnit("quarter");
  // Second anniversary quarter (from 2027-04-15): its start differs from the yearly anchor.
  const Q2 = "2027-05-10";
  await shiftFor(w.provider.staff._id, w.vegas._id, Q2);
  const member = await w.member(["aerwell-essential"]);
  for (const time of ["09:00", "11:00"])
    expect(
      (
        await w.api.post("/api/v1/appointments", {
          ...w.booking(member._id, "clinician-telehealth-visit"),
          startAt: at(Q2, time).toISOString(),
        })
      ).status
    ).toBe(201);
  await setUnit("year");
  const q = await w.quoteOf({
    ...w.booking(member._id, "clinician-telehealth-visit"),
    startAt: at(Q2, "13:00").toISOString(),
  });
  expect(q.body.data.allowance).toMatchObject({ usedBefore: 2, remainingAfter: 0 });
  expect(q.body.data.decision).toBe("retail");
});
