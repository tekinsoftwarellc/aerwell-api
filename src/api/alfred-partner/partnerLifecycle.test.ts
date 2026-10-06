import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY, at, pinClock } from "../../test/appointmentFixture.js";
import { installAlfredKeys, removeAlfredKeys } from "../../test/partnerFixture.js";
import { PAID, partnerWorld } from "../../test/partnerWorld.js";
import { AllowanceLedgerEntry, Appointment } from "../appointment/appointment.model.js";
import { Service } from "../service/service.model.js";

beforeEach(() => {
  pinClock();
  installAlfredKeys();
});
afterEach(() => {
  vi.useRealTimers();
  removeAlfredKeys();
});
const book = async (
  w: Awaited<ReturnType<typeof partnerWorld>>,
  time = "09:00",
  payment: object = PAID
) => {
  const res = await w.book("dexa-scan", time, { payment });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.bookingRef as string;
};
const setFee = (enabled: boolean, amountCents = 5000, windowHours = 24) =>
  Service.updateOne(
    { slug: "dexa-scan" },
    { lateCancellationFee: { enabled, amountCents, windowHours } }
  );
const hoursBefore = (time: string, hours: number) =>
  new Date(at(DAY, time).getTime() - hours * 3_600_000);

describe("cancellation quote and cancel", () => {
  it("free before the 24 hour window: full refund, the window end, nothing used", async () => {
    const w = await partnerWorld();
    await setFee(true, 5000);
    const ref = await book(w);
    const quote = await w.alfred.get(`/bookings/${ref}/cancellation-quote`);
    expect(quote.status).toBe(200);
    expect(quote.body.data).toMatchObject({
      allowed: true,
      feeCents: 0,
      refundCents: 17500,
      currency: "usd",
      windowEndsAt: hoursBefore("09:00", 24).toISOString(),
    });
    expect(quote.body.data.policyText).toMatch(/24 hours/);
    const cancel = await w.alfred.post(`/bookings/${ref}/cancel`, { reason: "Travelling" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data).toEqual({
      status: "cancelled",
      feeCents: 0,
      refundCents: 17500,
      currency: "usd",
      late: false,
    });
    const row = await Appointment.findById(ref).lean();
    expect(row).toMatchObject({
      status: "cancelled",
      cancellation: { by: "member", late: false, reason: "Travelling", allowance: "none" },
    });
    // Aerwell's ledger is never touched: the unit lives in Alfred.
    expect(await AllowanceLedgerEntry.countDocuments()).toBe(0);
    // The slot is bookable again.
    expect((await w.slots("dexa-scan")).map((s) => s.startAt)).toContain(
      at(DAY, "09:00").toISOString()
    );
  });

  it("inside 24 hours it is late: the unit is used whatever the fee, and the admin's fee applies", async () => {
    const w = await partnerWorld();
    await setFee(true, 5000);
    const ref = await book(w);
    vi.setSystemTime(hoursBefore("09:00", 10));
    const quote = await w.alfred.get(`/bookings/${ref}/cancellation-quote`);
    expect(quote.body.data).toMatchObject({
      allowed: true,
      feeCents: 5000,
      refundCents: 12500,
      windowEndsAt: null,
    });
    const cancel = await w.alfred.post(`/bookings/${ref}/cancel`, {});
    expect(cancel.body.data).toEqual({
      status: "cancelled",
      feeCents: 5000,
      refundCents: 12500,
      currency: "usd",
      late: true,
    });
    expect((await Appointment.findById(ref).lean())?.cancellation).toMatchObject({
      late: true,
      feeCents: 5000,
      refundCents: 12500,
    });
  });

  it("late with no fee configured is still late, with a zero fee and the full amount back", async () => {
    const w = await partnerWorld();
    const ref = await book(w);
    vi.setSystemTime(hoursBefore("09:00", 2));
    const cancel = await w.alfred.post(`/bookings/${ref}/cancel`, {});
    expect(cancel.body.data).toEqual({
      status: "cancelled",
      feeCents: 0,
      refundCents: 17500,
      currency: "usd",
      late: true,
    });
  });

  it("a fee larger than the payment never refunds a negative amount; the window is the service's own", async () => {
    const w = await partnerWorld();
    await setFee(true, 99_999, 48);
    const ref = await book(w, "09:00", { status: "none", amountCents: 1000, currency: "usd" });
    vi.setSystemTime(hoursBefore("09:00", 30));
    const cancel = await w.alfred.post(`/bookings/${ref}/cancel`, {});
    expect(cancel.body.data).toMatchObject({ feeCents: 99_999, refundCents: 0, late: true });
  });

  it("a repeat cancel under a new key returns the stored answer, keeping the late fee", async () => {
    const w = await partnerWorld();
    await setFee(true, 5000);
    const ref = await book(w);
    vi.setSystemTime(hoursBefore("09:00", 10));
    const first = await w.alfred.post(`/bookings/${ref}/cancel`, {}, "cancel-1");
    const again = await w.alfred.post(`/bookings/${ref}/cancel`, {}, "cancel-2");
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(first.body.data);
    expect(again.body.data.feeCents).toBe(5000);
    expect(await Appointment.countDocuments({ status: "cancelled" })).toBe(1);
  });

  it("after the start it is 409 OUTSIDE_CANCELLATION_WINDOW, and the quote says not allowed", async () => {
    const w = await partnerWorld();
    const ref = await book(w);
    vi.setSystemTime(at(DAY, "09:10"));
    const quote = await w.alfred.get(`/bookings/${ref}/cancellation-quote`);
    expect(quote.body.data).toMatchObject({ allowed: false, feeCents: 0, refundCents: 0 });
    const cancel = await w.alfred.post(`/bookings/${ref}/cancel`, {});
    expect([cancel.status, cancel.body.data]).toEqual([
      409,
      { code: "OUTSIDE_CANCELLATION_WINDOW" },
    ]);
    expect((await Appointment.findById(ref).lean())?.status).toBe("booked");
  });

  it("a booking already checked in or completed cannot be cancelled by the member", async () => {
    const w = await partnerWorld();
    const ref = await book(w);
    await Appointment.updateOne({ _id: ref }, { status: "checked_in" });
    const cancel = await w.alfred.post(`/bookings/${ref}/cancel`, {});
    expect([cancel.status, cancel.body.data]).toEqual([
      409,
      { code: "OUTSIDE_CANCELLATION_WINDOW" },
    ]);
  });

  it("one Idempotency-Key reused on another booking's cancel is a new request, not a replay", async () => {
    const w = await partnerWorld();
    const a = await book(w, "09:00");
    const b = await book(w, "11:00");
    expect((await w.alfred.post(`/bookings/${a}/cancel`, {}, "shared-key")).status).toBe(200);
    const second = await w.alfred.post(`/bookings/${b}/cancel`, {}, "shared-key");
    expect(second.status).toBe(200);
    expect(second.headers["idempotency-replayed"]).toBeUndefined();
    expect((await Appointment.findById(b).lean())?.status).toBe("cancelled");
  });

  it("is 404 for another member's booking and for an unknown or malformed ref", async () => {
    const w = await partnerWorld();
    const ref = await book(w);
    const other = await w.member([], { alfredAccountId: "6710bb4e2f9c1a0031d5e7b3" });
    const { alfredClient, alfredToken } = await import("../../test/partnerFixture.js");
    const { app } = await import("../../test/scheduleFixture.js");
    const stranger = alfredClient(app, alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7b3" }));
    expect(other).toBeTruthy();
    for (const path of [`/bookings/${ref}`, `/bookings/${ref}/cancellation-quote`])
      expect((await stranger.get(path)).status).toBe(404);
    expect((await stranger.post(`/bookings/${ref}/cancel`, {})).status).toBe(404);
    expect((await stranger.post(`/bookings/${ref}/check-in`, {})).status).toBe(404);
    expect((await w.alfred.get("/bookings/6710bb4e2f9c1a0031d5e7ff")).status).toBe(404);
    expect((await w.alfred.get("/bookings/not-an-id")).status).toBe(404);
    expect((await Appointment.findById(ref).lean())?.status).toBe("booked");
  });
});

describe("reschedule", () => {
  it("moves to a listed slot, keeps Alfred's payment, answers rescheduled, and frees the old slot", async () => {
    const w = await partnerWorld();
    const ref = await book(w);
    const target = await w.slotAt("dexa-scan", "13:00");
    const res = await w.alfred.post(`/bookings/${ref}/reschedule`, { slotRef: target.slotRef });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      bookingRef: ref,
      status: "rescheduled",
      startAt: target.startAt,
      endAt: target.endAt,
      payment: { status: "paid", amountCents: 17500, currency: "usd" },
    });
    const row = await Appointment.findById(ref).lean();
    expect(row).toMatchObject({ status: "booked", paymentStatus: "paid_external" });
    expect(row?.price).toMatchObject({ source: "alfred", amountCents: 17500 });
    const starts = (await w.slots("dexa-scan")).map((s) => s.startAt);
    expect(starts).toContain(at(DAY, "09:00").toISOString());
    expect(starts).not.toContain(target.startAt);
    expect((await w.alfred.get(`/bookings/${ref}`)).body.data.status).toBe("confirmed");
    expect(await AllowanceLedgerEntry.countDocuments()).toBe(0);
  });

  it("a repeat with the same key replays; moving to where it already is is a no-op", async () => {
    const w = await partnerWorld();
    const ref = await book(w);
    const target = await w.slotAt("dexa-scan", "13:00");
    const first = await w.alfred.post(
      `/bookings/${ref}/reschedule`,
      { slotRef: target.slotRef },
      "move-1"
    );
    const replay = await w.alfred.post(
      `/bookings/${ref}/reschedule`,
      { slotRef: target.slotRef },
      "move-1"
    );
    expect(replay.body).toEqual(first.body);
    const noop = await w.alfred.post(
      `/bookings/${ref}/reschedule`,
      { slotRef: target.slotRef },
      "move-2"
    );
    expect(noop.status).toBe(200);
    expect(noop.body.data.startAt).toBe(target.startAt);
  });

  it("SLOT_TAKEN when the new slot went, or the ref is for another item or place", async () => {
    const w = await partnerWorld();
    const ref = await book(w);
    const target = await w.slotAt("dexa-scan", "13:00");
    const rival = await w.member([], { alfredAccountId: "6710bb4e2f9c1a0031d5e7b4" });
    const { alfredClient, alfredToken } = await import("../../test/partnerFixture.js");
    const { app } = await import("../../test/scheduleFixture.js");
    const second = alfredClient(app, alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7b4" }));
    const taken = await second.post("/bookings", {
      ...w.bodyFor("dexa-scan", target),
      accountId: "6710bb4e2f9c1a0031d5e7b4",
    });
    expect(taken.status).toBe(201);
    expect(rival).toBeTruthy();
    const other = await w.slotAt("vo2-max-test", "15:00");
    for (const slotRef of [target.slotRef, other.slotRef, "garbage"]) {
      const res = await w.alfred.post(`/bookings/${ref}/reschedule`, { slotRef });
      expect([res.status, res.body.data]).toEqual([409, { code: "SLOT_TAKEN" }]);
    }
    expect((await Appointment.findById(ref).lean())?.startAt).toEqual(at(DAY, "09:00"));
  });

  it("inside the 24 hour window, or once cancelled, it is OUTSIDE_RESCHEDULE_WINDOW", async () => {
    const w = await partnerWorld();
    const ref = await book(w);
    const target = await w.slotAt("dexa-scan", "13:00");
    vi.setSystemTime(hoursBefore("09:00", 10));
    const late = await w.alfred.post(`/bookings/${ref}/reschedule`, { slotRef: target.slotRef });
    expect([late.status, late.body.data]).toEqual([409, { code: "OUTSIDE_RESCHEDULE_WINDOW" }]);
    vi.setSystemTime(hoursBefore("09:00", 100));
    await Appointment.updateOne({ _id: ref }, { status: "cancelled" });
    const gone = await w.alfred.post(`/bookings/${ref}/reschedule`, { slotRef: target.slotRef });
    expect([gone.status, gone.body.data]).toEqual([409, { code: "OUTSIDE_RESCHEDULE_WINDOW" }]);
  });
});

describe("check-in", () => {
  it("opens 60 minutes before the start, answers the same on a repeat, closes at the end", async () => {
    const w = await partnerWorld();
    const ref = await book(w);
    const early = await w.alfred.post(`/bookings/${ref}/check-in`, {});
    expect([early.status, early.body.data]).toEqual([409, { code: "CHECK_IN_WINDOW" }]);
    vi.setSystemTime(new Date(at(DAY, "09:00").getTime() - 30 * 60_000));
    const ok = await w.alfred.post(`/bookings/${ref}/check-in`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({
      status: "checked_in",
      checkedInAt: new Date(at(DAY, "09:00").getTime() - 30 * 60_000).toISOString(),
    });
    vi.setSystemTime(at(DAY, "09:20"));
    const repeat = await w.alfred.post(`/bookings/${ref}/check-in`, {});
    expect(repeat.body.data).toEqual(ok.body.data);
    expect((await w.alfred.get(`/bookings/${ref}`)).body.data).toMatchObject({
      status: "checked_in",
      checkedInAt: ok.body.data.checkedInAt,
    });
  });

  it("is CHECK_IN_WINDOW after the end and for a cancelled booking", async () => {
    const w = await partnerWorld();
    const ref = await book(w);
    vi.setSystemTime(at(DAY, "12:00"));
    expect((await w.alfred.post(`/bookings/${ref}/check-in`, {})).body.data).toEqual({
      code: "CHECK_IN_WINDOW",
    });
    await Appointment.updateOne({ _id: ref }, { status: "cancelled" });
    vi.setSystemTime(at(DAY, "08:50"));
    expect((await w.alfred.post(`/bookings/${ref}/check-in`, {})).status).toBe(409);
  });
});
