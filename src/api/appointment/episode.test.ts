import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DAY, at, bookingWorld, pinClock } from "../../test/appointmentFixture.js";
import { AllowanceLedgerEntry, Appointment, AssessmentEpisode } from "./appointment.model.js";

beforeEach(() => pinClock());
afterEach(() => vi.useRealTimers());
type World = Awaited<ReturnType<typeof bookingWorld>>;

async function openEpisode(w: World, memberId: unknown, extra: object = {}) {
  return w.api.post("/api/v1/assessment-episodes", {
    memberId: String(memberId),
    bundleServiceId: w.service("advanced-assessment"),
    locationId: String(w.vegas._id),
    ...extra,
  });
}
const component = (
  w: World,
  memberId: unknown,
  episodeId: string,
  slug: string,
  time: string,
  extra: object = {}
) =>
  w.api.post("/api/v1/appointments", { ...w.booking(memberId, slug, time), episodeId, ...extra });

it("one allowance unit covers the whole assessment; components never consume their own", async () => {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-essential"]);
  const q = await w.quoteOf({
    ...w.booking(member._id, "advanced-assessment"),
    deliveryMethod: "mobile_phlebotomy",
  });
  // A bundle is quoted as an episode at standard collection: no fee on the bundle itself.
  expect(q.body.data).toMatchObject({
    kind: "episode",
    decision: "allowance",
    finalCents: 0,
    feesCents: 0,
  });
  const opened = await openEpisode(w, member._id, {
    expectedQuote: { finalCents: 0, ruleVersion: q.body.data.ruleVersion },
  });
  expect(opened.status).toBe(201);
  const episodeId = opened.body.data.episode._id;
  expect(await AllowanceLedgerEntry.countDocuments({ episodeId, status: "reserved" })).toBe(1);
  const dexa = await component(w, member._id, episodeId, "dexa-scan", "09:00");
  const vo2 = await component(w, member._id, episodeId, "vo2-max-test", "10:00");
  const blood = await component(w, member._id, episodeId, "comprehensive-blood-panel", "11:00", {
    deliveryMethod: "mobile_phlebotomy",
  });
  const review = await component(w, member._id, episodeId, "assessment-clinician-review", "12:00");
  for (const res of [dexa, vo2, blood, review]) expect(res.status).toBe(201);
  expect([dexa, vo2, review].map((r) => r.body.data.appointment.amountDueCents)).toEqual([0, 0, 0]);
  // Mobile phlebotomy: charged once, on the blood draw.
  expect(blood.body.data.appointment.price).toMatchObject({
    decision: "episode_component",
    finalCents: 12000,
  });
  // Components hold no units of their own; the member's pool shows one assessment used.
  expect(await AllowanceLedgerEntry.countDocuments({ memberId: member._id, holding: true })).toBe(
    1
  );
  const again = await component(w, member._id, episodeId, "dexa-scan", "13:00");
  expect(again.body.code).toBe("EPISODE_COMPONENT_UNAVAILABLE");
  const benefits = await w.api.get(
    `/api/v1/members/${member._id}/benefits?at=${at(DAY, "09:00").toISOString()}`
  );
  const assessment = benefits.body.data.memberships[0].benefits.find(
    (b: { serviceId: string }) => b.serviceId === w.service("advanced-assessment")
  );
  expect(assessment).toMatchObject({ used: 1, remaining: 1 });
  expect(benefits.body.data.usage.tracked).toBe(true);
  // Completing components: the first consumes the episode unit; later ones consume nothing more.
  for (const res of [dexa, vo2, blood, review]) {
    const id = res.body.data.appointment._id;
    await w.api.patch(`/api/v1/appointments/${id}/status`, { status: "checked_in" });
    expect(
      (await w.api.patch(`/api/v1/appointments/${id}/status`, { status: "completed" })).status
    ).toBe(200);
    const rows = await AllowanceLedgerEntry.find({ memberId: member._id }).lean();
    expect(rows.map((r) => r.status)).toEqual(["consumed"]);
  }
  const done = await w.api.get(`/api/v1/assessment-episodes/${episodeId}`);
  expect(done.body.data.status).toBe("completed");
  expect(done.body.data.components.every((c: { fulfilled: boolean }) => c.fulfilled)).toBe(true);
});

it("a retail assessment is due once; its components are $0 plus the blood draw's mobile fee", async () => {
  const w = await bookingWorld();
  const member = await w.member();
  const opened = await openEpisode(w, member._id);
  expect(opened.body.data.episode).toMatchObject({
    amountDueCents: 99500,
    paymentStatus: "unconfigured",
    membershipId: null,
  });
  const episodeId = opened.body.data.episode._id;
  const vo2 = await component(w, member._id, episodeId, "vo2-max-test", "09:00");
  const blood = await component(w, member._id, episodeId, "comprehensive-blood-panel", "10:00", {
    deliveryMethod: "mobile_phlebotomy",
  });
  expect(vo2.body.data.appointment.amountDueCents).toBe(0);
  expect(blood.body.data.appointment.amountDueCents).toBe(12000);
  expect(await AllowanceLedgerEntry.countDocuments()).toBe(0);
  // Outside an episode the same component is retail.
  const standalone = await w.quoteOf(w.booking(member._id, "vo2-max-test", "11:00"));
  expect(standalone.body.data.finalCents).toBe(17500);
});

it("exhausted assessments fall back to retail; New York cannot open one", async () => {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-essential"]);
  expect((await openEpisode(w, member._id)).body.data.episode.amountDueCents).toBe(0);
  expect((await openEpisode(w, member._id)).body.data.episode.amountDueCents).toBe(0);
  const third = await openEpisode(w, member._id);
  expect(third.body.data.episode).toMatchObject({ amountDueCents: 99500 });
  expect(third.body.data.episode.price.decision).toBe("retail");
  const ny = await openEpisode(w, member._id, { locationId: String(w.newYork._id) });
  expect(ny.status).toBe(422);
  expect(ny.body.code).toBe("MARKET_UNAVAILABLE");
  const notBundle = await openEpisode(w, member._id, { bundleServiceId: w.service("dexa-scan") });
  expect(notBundle.body.code).toBe("NOT_A_BUNDLE");
});

it("cancelling an untouched episode releases the unit and its bookings; a started one refuses", async () => {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-continuum"]);
  const first = (await openEpisode(w, member._id, { idempotencyKey: "episode-key-1" })).body.data;
  const replay = (await openEpisode(w, member._id, { idempotencyKey: "episode-key-1" })).body.data;
  expect(replay).toMatchObject({ replayed: true, episode: { _id: first.episode._id } });
  const episodeId = first.episode._id;
  await component(w, member._id, episodeId, "dexa-scan", "09:00");
  const cancelled = await w.api.post(`/api/v1/assessment-episodes/${episodeId}/cancel`, {
    reason: "Moved",
  });
  expect(cancelled.body.data.status).toBe("cancelled");
  expect(await Appointment.countDocuments({ episodeId, status: "cancelled" })).toBe(1);
  expect((await AllowanceLedgerEntry.findOne({ episodeId }).lean())?.status).toBe("released");
  const closed = await component(w, member._id, episodeId, "vo2-max-test", "10:00");
  expect(closed.body.code).toBe("EPISODE_NOT_OPEN");
  // Started episode.
  const second = (await openEpisode(w, member._id)).body.data.episode._id;
  const dexa = await component(w, member._id, second, "dexa-scan", "11:00");
  const id = dexa.body.data.appointment._id;
  await w.api.patch(`/api/v1/appointments/${id}/status`, { status: "checked_in" });
  await w.api.patch(`/api/v1/appointments/${id}/status`, { status: "completed" });
  const refused = await w.api.post(`/api/v1/assessment-episodes/${second}/cancel`, {
    reason: "No",
  });
  expect(refused.body.code).toBe("EPISODE_IN_PROGRESS");
  const list = await w.api.get(`/api/v1/members/${member._id}/assessment-episodes`);
  expect(list.body.data.items.map((e: { status: string }) => e.status)).toEqual([
    "open",
    "cancelled",
  ]);
  expect(await AssessmentEpisode.countDocuments()).toBe(2);
});

it("review H1/M3/M1: a started or no-show component blocks the episode cancel and holds the unit", async () => {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-essential"]);
  const episodeId = (await openEpisode(w, member._id)).body.data.episode._id;
  const dexa = (await component(w, member._id, episodeId, "dexa-scan", "09:00")).body.data
    .appointment._id;
  const vo2 = (await component(w, member._id, episodeId, "vo2-max-test", "10:00")).body.data
    .appointment._id;
  await w.api.patch(`/api/v1/appointments/${dexa}/status`, { status: "checked_in" });
  await w.api.patch(`/api/v1/appointments/${dexa}/status`, { status: "in_progress" });
  const refused = await w.api.post(`/api/v1/assessment-episodes/${episodeId}/cancel`, {
    reason: "x",
  });
  expect(refused.body.code).toBe("EPISODE_IN_PROGRESS");
  expect((await AllowanceLedgerEntry.findOne({ episodeId }).lean())?.status).toBe("reserved");
  // A no-show component forfeits the episode unit.
  const noShow = await w.api.patch(`/api/v1/appointments/${vo2}/status`, { status: "no_show" });
  expect(noShow.body.data.status).toBe("no_show");
  expect((await AllowanceLedgerEntry.findOne({ episodeId }).lean())?.status).toBe("consumed");
  // Own-scope staff who deliver none of its components cannot see or cancel it.
  const { StaffMember } = await import("../staff/staff.model.js");
  const { staffFixture } = await import("../../test/staffFixture.js");
  const { as } = await import("../../test/scheduleFixture.js");
  const other = await staffFixture(false, 1);
  await StaffMember.updateOne(
    { _id: other.staff._id },
    { permissionOverrides: [{ module: "APPOINTMENTS", level: "edit", scope: "own" }] }
  );
  expect((await as(other.accessToken).get(`/api/v1/assessment-episodes/${episodeId}`)).status).toBe(
    404
  );
});
