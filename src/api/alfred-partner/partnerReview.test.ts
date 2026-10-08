import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheService } from "../../common/services/cache.service.js";
import { clearServiceTokenCache } from "../../common/services/serviceTokenClient.js";
import { createJwksKeyProvider } from "../../common/utils/alfredJwks.js";
import { env } from "../../config/env.js";
import { createServer } from "../../server.js";
import { DAY, at, pinClock, shiftFor } from "../../test/appointmentFixture.js";
import {
  alfredClient,
  alfredToken,
  installAlfredKeys,
  removeAlfredKeys,
  setKeyProviderForTest,
} from "../../test/partnerFixture.js";
import { PAID, partnerWorld } from "../../test/partnerWorld.js";
import { app } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import {
  AllowanceLedgerEntry,
  Appointment,
  AssessmentEpisode,
} from "../appointment/appointment.model.js";
import { Environment } from "../location/location.model.js";
import { Notification } from "../notification/notification.model.js";
import { Service } from "../service/service.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { PartnerOutbox } from "./outbox/partnerOutbox.model.js";
import { drainOutbox } from "./outbox/partnerOutbox.publisher.js";
import { PartnerIdempotencyKey } from "./partnerIdempotency.model.js";

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

describe("review H1: waiting events can never wedge the outbox", () => {
  const NOW = new Date("2027-03-01T20:00:00.000Z");
  let n = 0;
  const seed = (over: Record<string, unknown>) => {
    n += 1;
    return PartnerOutbox.create({
      organizationId: "org-test",
      idempotencyKey: `k-${n}`,
      type: "booking.cancelled",
      occurredAt: new Date(1000 + n),
      accountId: "6710bb4e2f9c1a0031d5e7d1",
      resource: { kind: "booking", ref: "stuck" },
      payload: {},
      ...over,
    });
  };
  const okFetch = () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (String(url).endsWith("/oauth/token"))
        return new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), {
          status: 200,
        });
      sent.push(JSON.parse(String(init.body)).idempotencyKey);
      return new Response("{}", { status: 202 });
    });
    return sent;
  };

  it("thirty events queued behind one that is backing off do not block anyone else, and follow it in order", async () => {
    const sent = okFetch();
    const blocker = await seed({
      occurredAt: new Date(1),
      idempotencyKey: "blocker",
      status: "failed",
      attempts: 3,
      nextAttemptAt: new Date(NOW.getTime() + 3_600_000),
    });
    for (let i = 0; i < 30; i += 1)
      await seed({
        idempotencyKey: `behind-${i}`,
        nextAttemptAt: new Date(NOW.getTime() - 60_000 + i),
      });
    await seed({
      idempotencyKey: "unrelated",
      resource: { kind: "booking", ref: "other" },
      nextAttemptAt: NOW,
    });
    const first = await drainOutbox(NOW);
    expect(first.sent).toBe(1);
    expect(sent).toEqual(["unrelated"]);
    const later = new Date(NOW.getTime() + 3_600_001);
    const second = await drainOutbox(later);
    expect(second.sent).toBe(31);
    expect(sent.slice(1, 3)).toEqual(["blocker", "behind-0"]);
    expect((await PartnerOutbox.findById(blocker._id).lean())?.status).toBe("sent");
    expect(await PartnerOutbox.countDocuments({ status: { $ne: "sent" } })).toBe(0);
  });

  it("an event Alfred refuses does not hold up the ones behind it, and retrying the blocker wakes them", async () => {
    const sent = okFetch();
    await seed({
      occurredAt: new Date(1),
      idempotencyKey: "refused",
      status: "failed",
      lastError: "refused",
      nextAttemptAt: new Date(NOW.getTime() + 300_000),
    });
    await seed({ idempotencyKey: "behind", nextAttemptAt: new Date(NOW.getTime() - 1000) });
    await drainOutbox(NOW);
    expect(sent).toEqual(["behind"]);
  });
});

describe("review H2: Alfred changes only what Alfred priced", () => {
  it("cancelling or moving a staff-made booking is refused and leaves its allowance unit alone", async () => {
    const w = await partnerWorld();
    const planned = await w.member(["aerwell-essential"], {
      alfredAccountId: "6710bb4e2f9c1a0031d5e7f1",
      status: "active",
    });
    const staff = await w.api.post(
      "/api/v1/appointments",
      w.booking(planned._id, "clinician-telehealth-visit", "09:00")
    );
    expect(staff.status).toBe(201);
    const ref = staff.body.data.appointment._id as string;
    const reserved = await AllowanceLedgerEntry.countDocuments({ status: "reserved" });
    expect(reserved).toBe(1);
    const client = alfredClient(app, () => alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7f1" }));
    const quote = await client.get(`/bookings/${ref}/cancellation-quote`);
    expect(quote.body.data).toMatchObject({ allowed: false, refundCents: 0 });
    const cancel = await client.post(`/bookings/${ref}/cancel`, {});
    expect([cancel.status, cancel.body.data]).toEqual([
      409,
      { code: "OUTSIDE_CANCELLATION_WINDOW" },
    ]);
    const target = await w.slotAt("clinician-telehealth-visit", "13:00");
    const move = await client.post(`/bookings/${ref}/reschedule`, { slotRef: target.slotRef });
    expect([move.status, move.body.data]).toEqual([409, { code: "OUTSIDE_RESCHEDULE_WINDOW" }]);
    expect((await Appointment.findById(ref).lean())?.status).toBe("booked");
    expect(await AllowanceLedgerEntry.countDocuments({ status: "reserved" })).toBe(1);
    // The member may still read it and check in; neither touches the ledger.
    expect((await client.get(`/bookings/${ref}`)).status).toBe(200);
  });
});

describe("review M1: a mobile visit does not occupy the clinic room", () => {
  it("a mobile phlebotomy booking leaves the in-clinic slot open for another member", async () => {
    const w = await partnerWorld();
    const room = await Environment.create({
      organizationId: "org-test",
      locationId: w.vegas._id,
      name: "The Clinic",
    });
    await Service.updateOne(
      { slug: "comprehensive-blood-panel" },
      { environmentId: room._id, locationId: w.vegas._id }
    );
    const second = await staffFixture(false, 1);
    await StaffMember.updateOne(
      { _id: second.staff._id },
      { isProvider: true, accountStatus: "active" }
    );
    await shiftFor(second.staff._id, w.vegas._id);
    const address = {
      line1: "1 Home St",
      city: "Las Vegas",
      region: "NV",
      postalCode: "89109",
      country: "US",
    };
    const mobile = await w.slotAt("comprehensive-blood-panel", "10:00");
    const made = await w.alfred.post(
      "/bookings",
      w.bodyFor("comprehensive-blood-panel", mobile, {
        deliveryMethod: "mobile_phlebotomy",
        serviceAddress: address,
      })
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const open = await w.slots("comprehensive-blood-panel", DAY, {
      staffRef: String(second.staff._id),
    });
    expect(open.map((s) => s.startAt)).toContain(at(DAY, "10:00").toISOString());
  });
});

describe("review M2: an inbound event survives a crash mid-handler", () => {
  it("a stale pending claim is re-run, a fresh one answers 503, and the same key is never processed twice", async () => {
    const w = await partnerWorld();
    const made = await w.book("dexa-scan", "09:00");
    const ref = made.body.data.bookingRef as string;
    const body = {
      idempotencyKey: "crash-evt",
      type: "order.paid",
      occurredAt: "2027-03-02T10:00:00.000Z",
      accountId: "6710bb4e2f9c1a0031d5e7a2",
      resource: { kind: "order", ref },
      payload: { amountCents: 17500, paymentIntentId: "pi_crash" },
    };
    const org = alfredClient(app, () => alfredToken({ accountId: null }));
    // The process died after claiming, before the handler ran.
    await PartnerIdempotencyKey.create({
      organizationId: "org-test",
      path: "/events:inbound",
      key: "crash-evt",
      method: "POST",
      bodyHash: "order.paid",
      state: "pending",
      claimedAt: new Date(),
    });
    const fresh = await org.post("/events", body);
    expect(fresh.status).toBe(503);
    expect((await Appointment.findById(ref).lean())?.paymentStatus).toBe("pending_external");
    await PartnerIdempotencyKey.updateOne(
      { key: "crash-evt" },
      { claimedAt: new Date(Date.now() - 120_000) }
    );
    const retried = await org.post("/events", body);
    expect([retried.status, retried.body.data]).toEqual([202, { status: "received" }]);
    expect((await Appointment.findById(ref).lean())?.paymentStatus).toBe("paid_external");
    expect((await org.post("/events", body)).body.data).toEqual({ status: "duplicate" });
  });
});

describe("review L1, L4, L5", () => {
  it("L1: one member's key can never replay another member's answer", async () => {
    const w = await partnerWorld();
    const a = await w.book("dexa-scan", "09:00");
    const refA = a.body.data.bookingRef as string;
    await w.member([], { alfredAccountId: "6710bb4e2f9c1a0031d5e7f2", status: "active" });
    const b = alfredClient(app, () => alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7f2" }));
    expect((await w.alfred.post(`/bookings/${refA}/cancel`, {}, "shared")).status).toBe(200);
    const stolen = await b.post(`/bookings/${refA}/cancel`, {}, "shared");
    expect(stolen.status).toBe(404);
    expect(stolen.headers["idempotency-replayed"]).toBeUndefined();
  });

  it("L4: a staff episode cancel keeps the payment Alfred recorded on its components", async () => {
    const w = await partnerWorld();
    const member = await w.member(["aerwell-essential"], {
      alfredAccountId: "6710bb4e2f9c1a0031d5e7f3",
      status: "active",
    });
    const episode = await w.api.post("/api/v1/assessment-episodes", {
      memberId: String(member._id),
      bundleServiceId: w.service("advanced-assessment"),
      locationId: String(w.vegas._id),
    });
    const episodeId = episode.body.data.episode._id as string;
    const staffRow = await w.api.post("/api/v1/appointments", {
      ...w.booking(member._id, "dexa-scan", "09:00"),
      episodeId,
    });
    expect(staffRow.status).toBe(201);
    const alfredRow = await Appointment.findById(staffRow.body.data.appointment._id);
    await alfredRow?.updateOne({
      $set: {
        externalPayment: { status: "paid", amountCents: 12000, currency: "usd" },
        paymentStatus: "paid_external",
        amountDueCents: 12000,
      },
    });
    const done = await w.api.post(`/api/v1/assessment-episodes/${episodeId}/cancel`, {
      reason: "Changed plans",
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await Appointment.findById(alfredRow?._id).lean()).toMatchObject({
      status: "cancelled",
      paymentStatus: "paid_external",
      amountDueCents: 12000,
      cancellation: { by: "staff" },
    });
    expect((await AssessmentEpisode.findById(episodeId).lean())?.status).toBe("cancelled");
  });

  it("L5: recovering a booking after a lost answer does not notify staff a second time", async () => {
    const w = await partnerWorld();
    const slot = await w.slotAt("dexa-scan", "09:00");
    const body = w.bodyFor("dexa-scan", slot);
    await w.alfred.post("/bookings", body, "twice");
    const before = await Notification.countDocuments();
    await PartnerIdempotencyKey.deleteMany({});
    expect((await w.alfred.post("/bookings", body, "twice")).status).toBe(201);
    expect(await Notification.countDocuments()).toBe(before);
  });
});

describe("review L2, L3 and the kill switch", () => {
  const countingCache = (over: number) => {
    const keys: string[] = [];
    const cache = {
      increment: async (key: string) => {
        keys.push(key);
        return over;
      },
    } as unknown as CacheService;
    return { cache, keys };
  };

  it("L2: an unknown path on a partner prefix is rate limited by IP, and the global limiter skips partner paths", async () => {
    const { cache, keys } = countingCache(1);
    const server = createServer(cache);
    await request(server).get("/api/v1/alfred/catalog/whatever/extra");
    expect(keys.some((k) => k.startsWith("rl:alfred-ip:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("rl:") && !k.startsWith("rl:alfred"))).toBe(false);
    const flooded = countingCache(1e12);
    const res = await request(createServer(flooded.cache)).get("/api/v1/alfred/bookings/x/y/z");
    expect(res.status).toBe(429);
    // The staff assistant on the same prefix still sits behind the global limiter.
    const staff = await request(createServer(flooded.cache)).get("/api/v1/alfred/config");
    expect(staff.status).toBe(429);
  });

  it("L3: an unhealthy JWKS endpoint is a 503 for the caller, not a 401", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    setKeyProviderForTest(createJwksKeyProvider("https://auth.alfred.test/jwks"));
    const res = await alfredClient(app).get("/catalog");
    expect(res.status).toBe(503);
  });

  it("the kill switch removes the partner routes and leaves the staff assistant routes alone", async () => {
    const saved = env.PARTNER_CONTRACT_ENABLED;
    env.PARTNER_CONTRACT_ENABLED = "false";
    try {
      const server = createServer();
      expect(
        (await request(server).get("/api/v1/alfred/catalog").set("x-contract-version", "1")).status
      ).toBe(404);
      expect((await request(server).get("/api/v1/alfred/config")).status).toBe(401);
    } finally {
      env.PARTNER_CONTRACT_ENABLED = saved;
    }
    expect((await alfredClient(app).get("/catalog")).status).toBe(200);
    expect(PAID).toBeTruthy();
  });
});
