import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinClock } from "../../test/appointmentFixture.js";
import {
  alfredClient,
  alfredToken,
  installAlfredKeys,
  removeAlfredKeys,
} from "../../test/partnerFixture.js";
import { partnerWorld } from "../../test/partnerWorld.js";
import { app } from "../../test/scheduleFixture.js";
import {
  AllowanceLedgerEntry,
  Appointment,
  AssessmentEpisode,
} from "../appointment/appointment.model.js";

beforeEach(() => {
  pinClock();
  installAlfredKeys();
});
afterEach(() => {
  vi.useRealTimers();
  removeAlfredKeys();
});
type World = Awaited<ReturnType<typeof partnerWorld>>;
const EPISODE = { ref: "ep-1", bundleRef: "advanced-assessment" };
const ADDRESS = {
  line1: "ADDRESS-SENTINEL-LINE",
  city: "Las Vegas",
  region: "NV",
  postalCode: "89109",
  country: "US",
};
const zero = { status: "none", amountCents: 0, currency: "usd" };
const component = (w: World, slug: string, time: string, extra: Record<string, unknown> = {}) =>
  w.book(slug, time, { episode: EPISODE, payment: zero, ...extra });
const code = (res: { body: { data?: { code?: string } } }) => res.body.data?.code;

describe("Advanced Assessment episode", () => {
  it("four components make one episode; mobile phlebotomy is on the blood draw only; no ledger row", async () => {
    const w = await partnerWorld();
    const blood = await component(w, "comprehensive-blood-panel", "09:00", {
      deliveryMethod: "mobile_phlebotomy",
      serviceAddress: ADDRESS,
      payment: { status: "none", amountCents: 12000, currency: "usd" },
    });
    const dexa = await component(w, "dexa-scan", "10:00");
    const vo2 = await component(w, "vo2-max-test", "11:00");
    const review = await component(w, "assessment-clinician-review", "12:00");
    for (const res of [blood, dexa, vo2, review])
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    const episodes = await AssessmentEpisode.find().lean();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      idempotencyKey: "alfred:ep-1",
      status: "open",
      paymentStatus: "not_required",
      amountDueCents: 0,
    });
    expect(String(episodes[0]?.bundleServiceId)).toBe(w.service("advanced-assessment"));
    expect(episodes[0]?.componentServiceIds).toHaveLength(4);
    const rows = await Appointment.find().lean();
    expect(rows.every((r) => String(r.episodeId) === String(episodes[0]?._id))).toBe(true);
    expect(rows.filter((r) => r.deliveryMethod === "mobile_phlebotomy")).toHaveLength(1);
    expect(await AllowanceLedgerEntry.countDocuments()).toBe(0);
    // Staff complete the four visits: the episode closes, and fulfilment settles nothing in Aerwell's ledger.
    for (const row of rows) {
      for (const status of ["checked_in", "completed"])
        expect(
          (await w.api.patch(`/api/v1/appointments/${row._id}/status`, { status })).status
        ).toBe(200);
    }
    expect((await AssessmentEpisode.findOne().lean())?.status).toBe("completed");
    expect(await AllowanceLedgerEntry.countDocuments()).toBe(0);
  });

  it("a component can be booked once; a non-component, an unknown bundle and another member's episode are refused", async () => {
    const w = await partnerWorld();
    expect((await component(w, "dexa-scan", "10:00")).status).toBe(201);
    const again = await component(w, "dexa-scan", "13:00");
    expect([again.status, code(again)]).toEqual([409, "ALREADY_BOOKED"]);
    expect((await component(w, "clinician-telehealth-visit", "14:00")).status).toBe(400);
    expect(
      (await component(w, "vo2-max-test", "14:00", { episode: { ref: "ep-1", bundleRef: "nope" } }))
        .status
    ).toBe(400);
    await w.member([], { alfredAccountId: "6710bb4e2f9c1a0031d5e7b5" });
    const slot = await w.slotAt("vo2-max-test", "15:00");
    const stranger = alfredClient(app, alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7b5" }));
    const res = await stranger.post("/bookings", {
      ...w.bodyFor("vo2-max-test", slot, { episode: EPISODE, payment: zero }),
      accountId: "6710bb4e2f9c1a0031d5e7b5",
    });
    expect(res.status).toBe(404);
    expect(await AssessmentEpisode.countDocuments()).toBe(1);
  });

  it("the clinician review cannot start before the last other component ends, nor can one end after it starts", async () => {
    const w = await partnerWorld();
    expect((await component(w, "dexa-scan", "12:00")).status).toBe(201);
    const early = await component(w, "assessment-clinician-review", "10:00");
    expect([early.status, code(early)]).toEqual([409, "OUTSIDE_BOOKING_WINDOW"]);
    const ok = await component(w, "assessment-clinician-review", "14:00");
    expect(ok.status).toBe(201);
    const after = await component(w, "vo2-max-test", "15:00");
    expect([after.status, code(after)]).toEqual([409, "OUTSIDE_BOOKING_WINDOW"]);
    expect((await component(w, "vo2-max-test", "13:00")).status).toBe(201);
  });

  it("mobile delivery only applies to the blood draw", async () => {
    const w = await partnerWorld();
    const res = await component(w, "dexa-scan", "10:00", {
      deliveryMethod: "mobile_phlebotomy",
      serviceAddress: ADDRESS,
    });
    expect(res.status).toBe(400);
    expect(await AssessmentEpisode.countDocuments()).toBe(0);
  });

  it("a refused first component leaves no episode behind", async () => {
    const w = await partnerWorld();
    const slot = await w.slotAt("dexa-scan", "10:00");
    expect((await w.alfred.post("/bookings", w.bodyFor("dexa-scan", slot))).status).toBe(201);
    const other = await w.member([], { alfredAccountId: "6710bb4e2f9c1a0031d5e7b6" });
    const rival = alfredClient(app, alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7b6" }));
    const res = await rival.post("/bookings", {
      ...w.bodyFor("dexa-scan", slot, {
        episode: { ref: "ep-9", bundleRef: "advanced-assessment" },
        payment: zero,
      }),
      accountId: "6710bb4e2f9c1a0031d5e7b6",
    });
    expect([res.status, code(res)]).toEqual([409, "SLOT_TAKEN"]);
    expect(other).toBeTruthy();
    expect(await AssessmentEpisode.countDocuments()).toBe(0);
  });

  it("cancelling one component keeps the episode open; cancelling the last live one cancels it", async () => {
    const w = await partnerWorld();
    const dexa = await component(w, "dexa-scan", "10:00");
    const vo2 = await component(w, "vo2-max-test", "11:00");
    await w.alfred.post(`/bookings/${dexa.body.data.bookingRef}/cancel`, {});
    expect((await AssessmentEpisode.findOne().lean())?.status).toBe("open");
    // The freed component can be booked again inside the open episode.
    expect((await component(w, "dexa-scan", "13:00")).status).toBe(201);
    for (const ref of [vo2.body.data.bookingRef])
      await w.alfred.post(`/bookings/${ref}/cancel`, {});
    expect((await AssessmentEpisode.findOne().lean())?.status).toBe("open");
    const live = await Appointment.find({ status: "booked" }).lean();
    for (const row of live) await w.alfred.post(`/bookings/${row._id}/cancel`, {});
    const closed = await AssessmentEpisode.findOne().lean();
    expect(closed?.status).toBe("cancelled");
    expect(closed?.cancelledAt).toBeTruthy();
    const late = await component(w, "vo2-max-test", "15:00");
    expect([late.status, code(late)]).toEqual([409, "OUTSIDE_BOOKING_WINDOW"]);
    expect(await AllowanceLedgerEntry.countDocuments()).toBe(0);
  });
});
