import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearServiceTokenCache } from "../../../common/services/serviceTokenClient.js";
import { env } from "../../../config/env.js";
import { partnerOutboxEnabled } from "../partner.config.js";
import { PartnerOutbox } from "./partnerOutbox.model.js";
import { drainOutbox } from "./partnerOutbox.publisher.js";

const NOW = new Date("2027-03-01T20:00:00.000Z");
beforeEach(() => clearServiceTokenCache());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Step = number | { status: number; retryAfter?: string; eventId?: string } | Error;
/** A scripted Alfred: the token endpoint always answers; the events endpoint follows the script (default 202). */
function fakeAlfred(script: Step[] = []) {
  const events: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
    [];
  let tokens = 0;
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    if (String(url).endsWith("/oauth/token")) {
      tokens += 1;
      return new Response(JSON.stringify({ access_token: `tok-${tokens}`, expires_in: 300 }), {
        status: 200,
      });
    }
    events.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    const step = script.shift() ?? 202;
    if (step instanceof Error) throw step;
    const { status, retryAfter, eventId } = typeof step === "number" ? { status: step } : step;
    return new Response(JSON.stringify({ data: { eventId: eventId ?? "evt-1" } }), {
      status,
      headers: retryAfter ? { "retry-after": retryAfter } : {},
    });
  });
  return { events, tokens: () => tokens };
}
let counter = 0;
const seed = (over: Record<string, unknown> = {}) => {
  counter += 1;
  return PartnerOutbox.create({
    organizationId: "org-test",
    idempotencyKey: `booking.cancelled:r${counter}:1`,
    type: "booking.cancelled",
    occurredAt: NOW,
    accountId: "6710bb4e2f9c1a0031d5e7d1",
    resource: { kind: "booking", ref: `r${counter}` },
    payload: { bookingRef: `r${counter}`, status: "cancelled" },
    nextAttemptAt: new Date(NOW.getTime() - 1000),
    ...over,
  });
};
const reload = (id: unknown) => PartnerOutbox.findById(id).lean();

describe("outbox publisher", () => {
  it("posts the event to Alfred with a service token and marks it sent", async () => {
    const alfred = fakeAlfred([{ status: 202, eventId: "evt-77" }]);
    const row = await seed();
    const result = await drainOutbox(NOW);
    expect(result).toEqual({ sent: 1, retried: 0, dead: 0, rateLimited: false });
    expect(alfred.events).toHaveLength(1);
    expect(alfred.events[0]?.url).toBe("https://alfred.test/api/v1/partner/events");
    expect(alfred.events[0]?.headers).toMatchObject({
      Authorization: "Bearer tok-1",
      "x-contract-version": "1",
    });
    expect(alfred.events[0]?.body).toEqual({
      idempotencyKey: "booking.cancelled:r1:1",
      type: "booking.cancelled",
      occurredAt: NOW.toISOString(),
      accountId: "6710bb4e2f9c1a0031d5e7d1",
      resource: { kind: "booking", ref: "r1" },
      payload: { bookingRef: "r1", status: "cancelled" },
    });
    expect(await reload(row._id)).toMatchObject({ status: "sent", alfredEventId: "evt-77" });
    // Nothing left to send: a second drain posts nothing.
    expect((await drainOutbox(NOW)).sent).toBe(0);
    expect(alfred.events).toHaveLength(1);
  });

  it("a catalog event goes without an account id", async () => {
    const alfred = fakeAlfred();
    await seed({
      type: "catalog.removed",
      accountId: undefined,
      resource: { kind: "catalog_item", ref: "dexa-scan" },
    });
    await drainOutbox(NOW);
    expect(alfred.events[0]?.body).not.toHaveProperty("accountId");
  });

  it("a 5xx backs off 10 s doubling, capped at an hour, and is dead after 12 attempts", async () => {
    fakeAlfred([500, 503, 500, 500]);
    const expected: [number, number][] = [
      [0, 10],
      [1, 20],
      [5, 320],
      [10, 3600],
    ];
    for (const [attempts, seconds] of expected) {
      const row = await seed({ attempts });
      await drainOutbox(NOW);
      const after = await reload(row._id);
      expect(after).toMatchObject({
        status: "failed",
        attempts: attempts + 1,
        lastError: "server_error",
        lastStatusCode: expect.any(Number),
      });
      expect(after?.nextAttemptAt.getTime()).toBe(NOW.getTime() + seconds * 1000);
    }
    fakeAlfred([500]);
    const last = await seed({ attempts: 11 });
    expect((await drainOutbox(NOW)).dead).toBe(1);
    expect(await reload(last._id)).toMatchObject({ status: "dead", attempts: 12 });
  });

  it("a network failure or timeout is retried and never leaks the error text", async () => {
    fakeAlfred([new Error("connect ECONNREFUSED 10.0.0.1 PHI-SENTINEL")]);
    const row = await seed();
    await drainOutbox(NOW);
    const after = await reload(row._id);
    expect(after).toMatchObject({ status: "failed", attempts: 1, lastError: "unreachable" });
    expect(JSON.stringify(after)).not.toContain("PHI-SENTINEL");
  });

  it("400 and 422 are dead at once; 403, 404, 409 and 410 wait five minutes without spending an attempt", async () => {
    fakeAlfred([400, 422, 403, 404, 409, 410]);
    for (const status of ["dead", "dead"]) {
      const row = await seed({ attempts: 2 });
      await drainOutbox(NOW);
      expect(await reload(row._id)).toMatchObject({ status, attempts: 2 });
    }
    for (let i = 0; i < 4; i += 1) {
      const row = await seed({ attempts: 2 });
      await drainOutbox(NOW);
      const after = await reload(row._id);
      expect(after).toMatchObject({ status: "failed", attempts: 2, lastError: "refused" });
      expect(after?.nextAttemptAt.getTime()).toBe(NOW.getTime() + 5 * 60_000);
    }
  });

  it("a 429 stops the batch, honours Retry-After, and leaves the rest untouched", async () => {
    const alfred = fakeAlfred([{ status: 429, retryAfter: "30" }]);
    const first = await seed();
    const second = await seed({ nextAttemptAt: new Date(NOW.getTime() - 500) });
    const third = await seed({ nextAttemptAt: new Date(NOW.getTime() - 400) });
    const result = await drainOutbox(NOW);
    expect(result.rateLimited).toBe(true);
    expect(alfred.events).toHaveLength(1);
    const held = await reload(first._id);
    expect(held).toMatchObject({ status: "pending", attempts: 0 });
    expect(held?.nextAttemptAt.getTime()).toBe(NOW.getTime() + 30_000);
    for (const row of [second, third])
      expect(await reload(row._id)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("a 401 mints a fresh token and tries once more", async () => {
    const alfred = fakeAlfred([401, 202]);
    const row = await seed();
    await drainOutbox(NOW);
    expect(alfred.tokens()).toBe(2);
    expect(alfred.events.map((e) => e.headers["Authorization"])).toEqual([
      "Bearer tok-1",
      "Bearer tok-2",
    ]);
    expect(await reload(row._id)).toMatchObject({ status: "sent" });
    clearServiceTokenCache();
    fakeAlfred([401, 401]);
    const stuck = await seed();
    await drainOutbox(NOW);
    expect(await reload(stuck._id)).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("two drains at once send each event exactly once", async () => {
    const alfred = fakeAlfred();
    const made = await Promise.all([seed(), seed(), seed(), seed()]);
    const [a, b] = await Promise.all([drainOutbox(NOW), drainOutbox(NOW)]);
    expect(a.sent + b.sent).toBe(4);
    expect(alfred.events).toHaveLength(4);
    expect(new Set(alfred.events.map((e) => e.body["idempotencyKey"])).size).toBe(4);
    for (const row of made) expect(await reload(row._id)).toMatchObject({ status: "sent" });
  });

  it("a claim left behind by a dead process is taken again after its lease, with the same key", async () => {
    const alfred = fakeAlfred();
    const live = await seed({ status: "sending", nextAttemptAt: new Date(NOW.getTime() + 60_000) });
    const dead = await seed({ status: "sending", nextAttemptAt: new Date(NOW.getTime() - 1) });
    await drainOutbox(NOW);
    expect(alfred.events.map((e) => e.body["idempotencyKey"])).toEqual([dead.idempotencyKey]);
    expect(await reload(live._id)).toMatchObject({ status: "sending" });
    expect(await reload(dead._id)).toMatchObject({ status: "sent" });
  });

  it("never sends a later event about a booking while an earlier one is still open", async () => {
    const alfred = fakeAlfred([500]);
    const created = await seed({
      type: "booking.created",
      resource: { kind: "booking", ref: "same" },
      occurredAt: new Date(1000),
    });
    const cancelled = await seed({
      type: "booking.cancelled",
      resource: { kind: "booking", ref: "same" },
      occurredAt: new Date(2000),
    });
    const other = await seed({
      type: "booking.created",
      resource: { kind: "booking", ref: "other" },
      occurredAt: new Date(3000),
    });
    await drainOutbox(NOW);
    // created failed (500) and backs off; cancelled is held behind it; the unrelated booking went.
    expect(await reload(created._id)).toMatchObject({ status: "failed" });
    expect(await reload(cancelled._id)).toMatchObject({ status: "pending", attempts: 0 });
    expect(await reload(other._id)).toMatchObject({ status: "sent" });
    expect(alfred.events.map((e) => e.body["type"])).toEqual([
      "booking.created",
      "booking.created",
    ]);
    const later = new Date(NOW.getTime() + 60_000);
    await drainOutbox(later);
    expect((await reload(created._id))?.status).toBe("sent");
    expect((await reload(cancelled._id))?.status).toBe("sent");
    const order = alfred.events
      .filter((e) => (e.body["resource"] as { ref: string }).ref === "same")
      .map((e) => e.body["type"]);
    expect(order).toEqual(["booking.created", "booking.created", "booking.cancelled"]);
  });

  it("does not touch rows that are not yet due, sent, or dead", async () => {
    const alfred = fakeAlfred();
    await seed({ nextAttemptAt: new Date(NOW.getTime() + 1000) });
    await seed({ status: "sent" });
    await seed({ status: "dead" });
    expect(await drainOutbox(NOW)).toEqual({ sent: 0, retried: 0, dead: 0, rateLimited: false });
    expect(alfred.events).toHaveLength(0);
  });

  it("sends at most the batch size per drain", async () => {
    const alfred = fakeAlfred();
    const saved = env.PARTNER_OUTBOX_BATCH_SIZE;
    env.PARTNER_OUTBOX_BATCH_SIZE = 2;
    try {
      for (let i = 0; i < 5; i += 1) await seed();
      await drainOutbox(NOW);
    } finally {
      env.PARTNER_OUTBOX_BATCH_SIZE = saved;
    }
    expect(alfred.events).toHaveLength(2);
  });

  it("with no token available the event waits and keeps its place", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const row = await seed();
    await drainOutbox(NOW);
    expect(await reload(row._id)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "no_token",
    });
  });

  it("is on only when configured, unless switched", () => {
    expect(partnerOutboxEnabled()).toBe(true);
    const saved = env.PARTNER_OUTBOX_ENABLED;
    env.PARTNER_OUTBOX_ENABLED = "false";
    expect(partnerOutboxEnabled()).toBe(false);
    env.PARTNER_OUTBOX_ENABLED = saved;
    const url = env.ALFRED_API_URL;
    env.ALFRED_API_URL = undefined;
    expect(partnerOutboxEnabled()).toBe(false);
    env.ALFRED_API_URL = url;
  });
});
