import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearServiceTokenCache } from "../../../common/services/serviceTokenClient.js";
import { env } from "../../../config/env.js";
import { DAY, at, pinClock } from "../../../test/appointmentFixture.js";
import { staffWith } from "../../../test/memberFixture.js";
import { installAlfredKeys, removeAlfredKeys } from "../../../test/partnerFixture.js";
import { PAID, partnerWorld } from "../../../test/partnerWorld.js";
import { as } from "../../../test/scheduleFixture.js";
import { AllowanceLedgerEntry, Appointment } from "../../appointment/appointment.model.js";
import { Location } from "../../location/location.model.js";
import { Member } from "../../member/member.model.js";
import { Service } from "../../service/service.model.js";
import { PartnerOutbox } from "./partnerOutbox.model.js";

beforeEach(() => {
  pinClock();
  installAlfredKeys();
  clearServiceTokenCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  removeAlfredKeys();
});
type World = Awaited<ReturnType<typeof partnerWorld>>;
const rows = (type?: string) =>
  PartnerOutbox.find(type ? { type } : {})
    .sort({ _id: 1 })
    .lean();

/** A staff booking of the Alfred-linked member, made through the staff API like the front desk does. */
let linked = 0;
async function staffBook(w: World, slug = "dexa-scan", time = "09:00", extra: object = {}) {
  linked += 1;
  const member = await w.member(["aerwell-essential"], {
    alfredAccountId: `6710bb4e2f9c1a0031d5e7${(0xd0 + linked).toString(16)}`,
    status: "active",
  });
  const res = await w.api.post("/api/v1/appointments", {
    ...w.booking(member._id, slug, time),
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { member, id: res.body.data.appointment._id as string };
}

describe("events the outbox writes for staff changes", () => {
  it("a staff booking of a linked member queues booking.created with the contract payload and nothing clinical", async () => {
    const w = await partnerWorld();
    const { id } = await staffBook(w, "dexa-scan", "09:00", {
      reason: "assessment",
      reasonDetail: "REASON-SENTINEL-TEXT",
      memberNote: "NOTE-SENTINEL-TEXT",
    });
    const [row] = await rows("booking.created");
    expect(row).toMatchObject({
      status: "pending",
      attempts: 0,
      accountId: expect.stringMatching(/^6710bb4e2f9c1a0031d5e7[0-9a-f]{2}$/),
      resource: { kind: "booking", ref: id },
    });
    expect(row?.idempotencyKey).toMatch(new RegExp(`^booking\\.created:${id}:\\d+$`));
    expect(row?.payload).toEqual({
      bookingRef: id,
      itemRef: "dexa-scan",
      status: "confirmed",
      startAt: at(DAY, "09:00"),
      endAt: at(DAY, "10:00"),
      locationRef: String(w.vegas._id),
      staff: { ref: String(w.provider.staff._id), name: "Dr. Diebel", role: expect.any(String) },
      payment: { status: "none", amountCents: 0, currency: "usd" },
      summary: {
        displayRef: expect.stringMatching(/^B-[A-Z2-9]{6}$/),
        title: "DEXA Scan",
        locationName: "Aerwell Las Vegas",
        staffName: "Dr. Diebel",
      },
      tags: ["physical", "lab"],
    });
    const text = JSON.stringify(row);
    for (const secret of ["SENTINEL", "assessment", "Last", "First", "example.invalid"])
      expect(text).not.toContain(secret);
  });

  it("a member Alfred does not know, or has unlinked, produces nothing", async () => {
    const w = await partnerWorld();
    const plain = await w.member(["aerwell-essential"]);
    expect(
      (await w.api.post("/api/v1/appointments", w.booking(plain._id, "dexa-scan"))).status
    ).toBe(201);
    const { member } = await staffBook(w, "dexa-scan", "11:00");
    expect(await PartnerOutbox.countDocuments()).toBe(1);
    await Member.updateOne({ _id: member._id }, { alfredUnlinkedAt: new Date() });
    const again = await w.api.post(
      "/api/v1/appointments",
      w.booking(member._id, "vo2-max-test", "13:00")
    );
    expect(again.status).toBe(201);
    expect(await PartnerOutbox.countDocuments()).toBe(1);
  });

  it("a staff cancel queues booking.cancelled with cancelledBy staff, the fee, the refund and late", async () => {
    const w = await partnerWorld();
    const made = await w.book("dexa-scan", "09:00", { payment: PAID });
    const ref = made.body.data.bookingRef as string;
    await Service.updateOne(
      { slug: "dexa-scan" },
      { lateCancellationFee: { enabled: true, amountCents: 5000, windowHours: 24 } }
    );
    // Ten hours before the start, by moving the visit rather than the clock (the staff session expires).
    const soon = new Date(Date.now() + 10 * 3_600_000);
    await Appointment.updateOne(
      { _id: ref },
      { startAt: soon, endAt: new Date(soon.getTime() + 3_600_000) }
    );
    const cancelled = await w.api.post(`/api/v1/appointments/${ref}/cancel`, {
      reason: "Provider unwell",
    });
    expect(cancelled.status).toBe(200);
    const [row] = await rows("booking.cancelled");
    expect(row?.payload).toMatchObject({
      bookingRef: ref,
      status: "cancelled",
      cancelledBy: "staff",
      feeCents: 5000,
      refundCents: 12500,
      late: true,
    });
    expect(JSON.stringify(row)).not.toContain("Provider unwell");
    // The waived fee goes up as no fee and not late.
    const second = await w.book("vo2-max-test", "13:00", { payment: PAID });
    await w.api.post(`/api/v1/appointments/${second.body.data.bookingRef}/cancel`, {
      reason: "Waived",
      waiveFee: true,
    });
    expect((await rows("booking.cancelled")).at(-1)?.payload).toMatchObject({
      feeCents: 0,
      refundCents: 17500,
      late: false,
    });
  });

  it("staff reschedule, check-in, completion and no-show are queued with their own payloads", async () => {
    const w = await partnerWorld();
    const { id } = await staffBook(w, "dexa-scan", "09:00");
    const moved = await w.api.post(`/api/v1/appointments/${id}/reschedule`, {
      startAt: at(DAY, "13:00").toISOString(),
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await rows("booking.rescheduled"))[0]?.payload).toMatchObject({
      bookingRef: id,
      status: "rescheduled",
      startAt: at(DAY, "13:00"),
      previousStartAt: at(DAY, "09:00"),
    });
    const patch = (status: string) => w.api.patch(`/api/v1/appointments/${id}/status`, { status });
    expect((await patch("checked_in")).status).toBe(200);
    expect((await patch("completed")).status).toBe(200);
    expect((await rows("booking.checked_in"))[0]?.payload).toMatchObject({
      bookingRef: id,
      status: "checked_in",
    });
    expect((await rows("booking.completed"))[0]?.payload).toMatchObject({
      bookingRef: id,
      status: "completed",
    });
    const other = await staffBook(w, "vo2-max-test", "15:00");
    await w.api.patch(`/api/v1/appointments/${other.id}/status`, { status: "no_show" });
    expect((await rows("booking.completed")).at(-1)?.payload).toMatchObject({
      bookingRef: other.id,
      status: "no_show",
    });
  });

  it("cancelling a whole assessment queues one booking.cancelled per component", async () => {
    const w = await partnerWorld();
    const member = await w.member(["aerwell-essential"], {
      alfredAccountId: "6710bb4e2f9c1a0031d5e7d2",
      status: "active",
    });
    const episode = await w.api.post("/api/v1/assessment-episodes", {
      memberId: String(member._id),
      bundleServiceId: w.service("advanced-assessment"),
      locationId: String(w.vegas._id),
    });
    expect(episode.status).toBe(201);
    const episodeId = episode.body.data.episode._id;
    for (const [slug, time] of [
      ["dexa-scan", "09:00"],
      ["vo2-max-test", "10:00"],
    ] as const)
      expect(
        (
          await w.api.post("/api/v1/appointments", {
            ...w.booking(member._id, slug, time),
            episodeId,
          })
        ).status
      ).toBe(201);
    const cancelled = await w.api.post(`/api/v1/assessment-episodes/${episodeId}/cancel`, {
      reason: "Changed plans",
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const events = await rows("booking.cancelled");
    expect(events).toHaveLength(2);
    expect(
      events.every((e) => (e.payload as { cancelledBy: string }).cancelledBy === "staff")
    ).toBe(true);
  });

  it("the row is written inside the staff change's transaction (same session), so a crash after commit loses nothing", async () => {
    const w = await partnerWorld();
    const { id } = await staffBook(w, "dexa-scan", "09:00");
    const spy = vi.spyOn(PartnerOutbox, "updateOne");
    expect((await w.api.post(`/api/v1/appointments/${id}/cancel`, { reason: "Yes" })).status).toBe(
      200
    );
    const calls = spy.mock.calls as unknown as [
      { idempotencyKey?: string },
      unknown,
      { session?: unknown }?,
    ][];
    const writes = calls.filter(([filter]) =>
      String(filter.idempotencyKey).startsWith("booking.cancelled")
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[2]?.session).toBeTruthy();
  });

  it("the row commits with the change: a failed enqueue rolls the staff change back, a success has both", async () => {
    const w = await partnerWorld();
    const { id } = await staffBook(w, "dexa-scan", "09:00");
    const spy = vi.spyOn(PartnerOutbox, "updateOne").mockRejectedValueOnce(new Error("disk full"));
    const failed = await w.api.post(`/api/v1/appointments/${id}/cancel`, { reason: "Nope" });
    expect(failed.status).toBe(500);
    expect((await Appointment.findById(id).lean())?.status).toBe("booked");
    spy.mockRestore();
    expect((await w.api.post(`/api/v1/appointments/${id}/cancel`, { reason: "Yes" })).status).toBe(
      200
    );
    expect((await Appointment.findById(id).lean())?.status).toBe("cancelled");
    expect(await PartnerOutbox.countDocuments({ type: "booking.cancelled" })).toBe(1);
  });

  it("a payload that cannot be built is logged and skipped; it never blocks the staff booking", async () => {
    const w = await partnerWorld();
    vi.spyOn(Location, "find").mockImplementationOnce(() => {
      throw new Error("lookup failed");
    });
    const member = await w.member(["aerwell-essential"], {
      alfredAccountId: "6710bb4e2f9c1a0031d5e7d3",
      status: "active",
    });
    const res = await w.api.post(
      "/api/v1/appointments",
      w.booking(member._id, "dexa-scan", "09:00")
    );
    expect(res.status).toBe(201);
    expect(await PartnerOutbox.countDocuments()).toBe(0);
  });

  it("an event key is stable, so a repeat is a no-op, and a long one is hashed", async () => {
    const { eventKey, enqueue } = await import("./partnerOutbox.service.js");
    const event = {
      type: "booking.created",
      occurredAt: new Date(5),
      resource: { kind: "booking", ref: "abc" },
      payload: {},
    };
    expect(eventKey(event)).toBe("booking.created:abc:5");
    await enqueue(event);
    await enqueue(event);
    expect(await PartnerOutbox.countDocuments()).toBe(1);
    const long = { ...event, resource: { kind: "booking", ref: "x".repeat(200) } };
    expect(eventKey(long)).toMatch(/^booking\.created:h:[a-f0-9]{32}$/);
    expect(eventKey(long)).toBe(eventKey(long));
  });
});

describe("staff changes to a booking Alfred priced and charged", () => {
  it("a staff reschedule keeps Alfred's payment record and touches no allowance or ledger", async () => {
    const w = await partnerWorld();
    const made = await w.book("dexa-scan", "09:00", { payment: PAID });
    const ref = made.body.data.bookingRef as string;
    const moved = await w.api.post(`/api/v1/appointments/${ref}/reschedule`, {
      startAt: at(DAY, "13:00").toISOString(),
    });
    // The member holds no plan: Aerwell's own pricing would refuse. Alfred's booking is not re-priced.
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const row = await Appointment.findById(ref).lean();
    expect(row).toMatchObject({
      paymentStatus: "paid_external",
      amountDueCents: 17500,
      startAt: at(DAY, "13:00"),
    });
    expect(row?.price).toMatchObject({
      source: "alfred",
      amountCents: 17500,
      paymentIntentId: "pi_test_123",
    });
    expect(await AllowanceLedgerEntry.countDocuments()).toBe(0);
    expect((await rows("booking.rescheduled"))[0]?.payload).toMatchObject({ bookingRef: ref });
  });

  it("a staff cancel leaves the payment as Alfred recorded it, and is late by the window whatever the fee", async () => {
    const w = await partnerWorld();
    const made = await w.book("dexa-scan", "09:00", { payment: PAID });
    const ref = made.body.data.bookingRef as string;
    const soon = new Date(Date.now() + 10 * 3_600_000);
    await Appointment.updateOne(
      { _id: ref },
      { startAt: soon, endAt: new Date(soon.getTime() + 3_600_000) }
    );
    expect(
      (await w.api.post(`/api/v1/appointments/${ref}/cancel`, { reason: "Clinic closed" })).status
    ).toBe(200);
    const row = await Appointment.findById(ref).lean();
    expect(row).toMatchObject({
      status: "cancelled",
      paymentStatus: "paid_external",
      amountDueCents: 17500,
      cancellation: { by: "staff", late: true, feeCents: 0 },
    });
    expect((await rows("booking.cancelled"))[0]?.payload).toMatchObject({
      cancelledBy: "staff",
      feeCents: 0,
      refundCents: 17500,
      late: true,
    });
    expect(await AllowanceLedgerEntry.countDocuments()).toBe(0);
    expect((await w.alfred.get(`/bookings/${ref}`)).body.data.payment).toEqual({
      status: "paid",
      amountCents: 17500,
      currency: "usd",
    });
  });
});

describe("catalog events", () => {
  const staffPatch = (w: World, slug: string, body: object) =>
    Service.findOne({ slug }).then((s) =>
      w.api.patch(`/api/v1/services/${s?._id}`, { expectedVersion: s?.get("version"), ...body })
    );

  it("a service edit queues catalog.upserted with the full item and its updatedAt as the version", async () => {
    const w = await partnerWorld();
    const res = await staffPatch(w, "dexa-scan", { description: "Updated description" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await rows("catalog.upserted");
    const service = await Service.findOne({ slug: "dexa-scan" }).lean();
    expect(row?.accountId).toBeUndefined();
    expect(row?.resource).toEqual({ kind: "catalog_item", ref: "dexa-scan" });
    expect(row?.payload).toMatchObject({
      partnerRef: "dexa-scan",
      description: "Updated description",
      locations: [String(w.vegas._id)],
      version: service?.updatedAt.getTime(),
    });
  });

  it("archiving queues catalog.removed; the Alfred-owned bundle is never announced", async () => {
    const w = await partnerWorld();
    const dexa = await Service.findOne({ slug: "dexa-scan" });
    const bundle = await Service.findOne({ slug: "advanced-assessment" });
    const res = await w.api.post("/api/v1/services/bulk", {
      ids: [String(dexa?._id), String(bundle?._id)],
      action: "archive",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await rows("catalog.removed")).map((r) => r.payload)).toEqual([
      { partnerRef: "dexa-scan" },
    ]);
    expect((await rows()).map((r) => r.resource?.ref)).not.toContain("advanced-assessment");
  });

  it("a market edit announces the services it affects", async () => {
    const w = await partnerWorld();
    const markets = await w.api.get("/api/v1/markets");
    const market = markets.body.data.find((m: { slug: string }) => m.slug === "las-vegas");
    await w.api.patch(`/api/v1/markets/${market.id ?? market._id}`, {
      locationIds: [String(w.vegas._id), String(w.newYork._id)],
      expectedVersion: market.version,
    });
    const refs = (await rows("catalog.upserted")).map((r) => r.resource?.ref);
    expect(refs).toContain("dexa-scan");
    expect(refs).toContain("comprehensive-blood-panel");
  });

  it("queues nothing while Alfred's address is not configured", async () => {
    const w = await partnerWorld();
    const saved = env.ALFRED_API_URL;
    env.ALFRED_API_URL = undefined;
    try {
      await staffPatch(w, "dexa-scan", { description: "Quiet" });
    } finally {
      env.ALFRED_API_URL = saved;
    }
    expect(await PartnerOutbox.countDocuments()).toBe(0);
  });
});

describe("staff view and retry", () => {
  const seed = (status: string, over: object = {}) =>
    PartnerOutbox.create({
      organizationId: "org-test",
      idempotencyKey: `k-${Math.random()}`,
      type: "booking.cancelled",
      occurredAt: new Date(),
      accountId: "6710bb4e2f9c1a0031d5e7d1",
      resource: { kind: "booking", ref: "r" },
      payload: { secret: "PAYLOAD-SENTINEL" },
      status,
      attempts: 12,
      lastError: "server_error",
      ...over,
    });

  it("lists counts and the stuck rows without payloads, and retries a dead one", async () => {
    const w = await partnerWorld();
    const dead = await seed("dead");
    await seed("failed");
    await seed("sent");
    const res = await w.api.get("/api/v1/partner-outbox");
    expect(res.status).toBe(200);
    expect(res.body.data.counts).toEqual({ pending: 0, sending: 0, sent: 1, failed: 1, dead: 1 });
    expect(res.body.data.items).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toContain("PAYLOAD-SENTINEL");
    const retry = await w.api.post(`/api/v1/partner-outbox/${dead._id}/retry`);
    expect(retry.body.data).toEqual({ id: String(dead._id), status: "pending" });
    expect(await PartnerOutbox.findById(dead._id).lean()).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
    });
  });

  it("only a failed or dead event can be retried, and the permission is checked", async () => {
    const w = await partnerWorld();
    const sent = await seed("sent");
    expect((await w.api.post(`/api/v1/partner-outbox/${sent._id}/retry`)).status).toBe(404);
    expect((await w.api.post("/api/v1/partner-outbox/not-an-id/retry")).status).toBe(400);
    const nobody = await staffWith({});
    expect((await as(nobody.accessToken).get("/api/v1/partner-outbox")).status).toBe(403);
    const viewer = await staffWith({ SYSTEM_SETTINGS: "view" });
    expect((await as(viewer.accessToken).get("/api/v1/partner-outbox")).status).toBe(200);
    const dead = await seed("dead");
    expect(
      (await as(viewer.accessToken).post(`/api/v1/partner-outbox/${dead._id}/retry`)).status
    ).toBe(403);
  });
});
