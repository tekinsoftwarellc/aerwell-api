import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookingWorld } from "../../test/appointmentFixture.js";
import {
  ACCOUNT,
  alfredClient,
  alfredToken,
  installAlfredKeys,
  removeAlfredKeys,
} from "../../test/partnerFixture.js";
import { app } from "../../test/scheduleFixture.js";
import { AllowanceLedgerEntry } from "../appointment/appointment.model.js";
import { buildQuote, priceOf } from "../appointment/quote.service.js";
import { MembershipPlan } from "../catalog/catalog.model.js";
import { Member, MemberMembership } from "../member/member.model.js";

beforeEach(installAlfredKeys);
afterEach(removeAlfredKeys);
const client = () => alfredClient(app);
const path = `/members/${ACCOUNT}/membership`;
const profile = { firstName: "Dana", lastName: "Reyes" };
const provision = (extra: Record<string, unknown> = {}) =>
  client().post("/members", {
    accountId: ACCOUNT,
    profile,
    membership: null,
    ...extra,
  });
const stored = async () =>
  (await Member.findOne({ alfredAccountId: ACCOUNT }).lean())?.alfredMembership;
const until = "2027-09-16T00:00:00.000Z";

describe("POST /members/{accountId}/membership", () => {
  it("sets, changes tier, suspends and cancels, answering the contract body", async () => {
    const made = await provision();
    const ref = made.body.data.partnerRef;
    const open = await client().post(path, {
      tierKey: "aerwell-essential",
      status: "active",
      validUntil: until,
    });
    expect(open.status).toBe(200);
    expect(open.body.data).toEqual({
      partnerRef: ref,
      tierKey: "aerwell-essential",
      status: "active",
      validUntil: until,
    });
    expect(await stored()).toMatchObject({
      tierKey: "aerwell-essential",
      status: "active",
      validUntil: new Date(until),
    });
    await client().post(path, {
      tierKey: "aerwell-continuum",
      status: "active",
    });
    const changed = await stored();
    expect(changed).toMatchObject({
      tierKey: "aerwell-continuum",
      status: "active",
    });
    // Omitted validUntil is open-ended: it clears the previous one (§5.2).
    expect(changed?.validUntil).toBeUndefined();
    await client().post(path, {
      tierKey: "aerwell-continuum",
      status: "suspended",
    });
    expect((await stored())?.status).toBe("suspended");
    await client().post(path, {
      tierKey: "bundled",
      status: "cancelled",
      validUntil: until,
    });
    expect(await stored()).toMatchObject({
      tierKey: "bundled",
      status: "cancelled",
    });
  });
  it("replays the same Idempotency-Key with the same body and does not write twice", async () => {
    await provision();
    const body = { tierKey: "aerwell-essential", status: "active" };
    const first = await client().post(path, body, "mship-1");
    const at = (await stored())?.updatedAt;
    const replay = await client().post(path, body, "mship-1");
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect((await stored())?.updatedAt).toEqual(at);
    expect((await client().post(path, { ...body, status: "suspended" }, "mship-1")).status).toBe(
      422
    );
  });
  it("is a plain 404 for a member Aerwell does not hold", async () => {
    const res = await client().post(path, {
      tierKey: "aerwell-essential",
      status: "active",
    });
    expect(res.status).toBe(404);
    expect(res.body.data?.code).toBeUndefined();
  });
  it("is 404 for an unlinked member", async () => {
    await provision();
    await Member.updateOne({ alfredAccountId: ACCOUNT }, { alfredUnlinkedAt: new Date() });
    expect((await client().post(path, { tierKey: "bundled", status: "active" })).status).toBe(404);
  });
  it("is 400 when the path account differs from act.sub", async () => {
    await provision();
    const other = "6710bb4e2f9c1a0031d5e7a3";
    const res = await client().post(`/members/${other}/membership`, {
      tierKey: "bundled",
      status: "active",
    });
    expect(res.status).toBe(400);
    expect(await stored()).toBeUndefined();
  });
  it("is 400 (not 404) for a mismatched path even when the acting member is unknown", async () => {
    const other = "6710bb4e2f9c1a0031d5e7a3";
    const res = await client().post(`/members/${other}/membership`, {
      tierKey: "bundled",
      status: "active",
    });
    expect(res.status).toBe(400);
  });
  it("is 400 for an unknown status, empty tier, unknown key or bad date; 401 without act", async () => {
    await provision();
    const bad = (b: Record<string, unknown>) =>
      client().post(path, { tierKey: "bundled", status: "active", ...b });
    expect((await bad({ status: "paused" })).status).toBe(400);
    expect((await bad({ tierKey: "" })).status).toBe(400);
    expect((await bad({ plan: "x" })).status).toBe(400);
    expect((await bad({ validUntil: "tomorrow" })).status).toBe(400);
    expect(await stored()).toBeUndefined();
    const noAct = alfredClient(app, alfredToken({ accountId: null }));
    expect((await noAct.post(path, { tierKey: "bundled", status: "active" })).status).toBe(401);
  });
});

describe("POST /members stores the membership it carries", () => {
  it("records a sent membership (with or without validUntil) and keeps it on a null re-provision", async () => {
    await provision({
      membership: {
        tierKey: "aerwell-continuum",
        status: "suspended",
        validUntil: until,
      },
    });
    expect(await stored()).toMatchObject({
      tierKey: "aerwell-continuum",
      status: "suspended",
      validUntil: new Date(until),
    });
    await provision({ membership: null });
    expect((await stored())?.tierKey).toBe("aerwell-continuum");
    await provision({ membership: { tierKey: "bundled", status: "active" } });
    expect(await stored()).toMatchObject({
      tierKey: "bundled",
      status: "active",
    });
  });
  it("stores nothing when the member was provisioned with null", async () => {
    await provision();
    expect(await stored()).toBeUndefined();
  });
});

describe("the record never reaches staff entitlement (Q4: no reverse flow)", () => {
  it("leaves MemberMembership, ledger, plans and the real quote path unchanged", async () => {
    const w = await bookingWorld();
    const made = await provision();
    const memberId = made.body.data.partnerRef;
    const startAt = new Date("2027-03-01T17:00:00.000Z");
    const now = new Date("2027-02-20T12:00:00.000Z");
    // buildQuote is what booking and quoting use: catalog snapshot + the member's MemberMembership rows.
    const quotes = async () =>
      Promise.all(
        ["comprehensive-blood-panel", "dexa-scan"].map(async (slug) =>
          priceOf(
            (
              await buildQuote(
                "org-test",
                {
                  memberId,
                  serviceId: w.service(slug),
                  locationId: String(w.vegas._id),
                  startAt,
                  deliveryMethod: "standard",
                },
                null,
                now
              )
            ).quote
          )
        )
      );
    const counts = async () => [
      await MemberMembership.countDocuments(),
      await AllowanceLedgerEntry.countDocuments(),
      await MembershipPlan.countDocuments(),
    ];
    const before = { quotes: await quotes(), counts: await counts() };
    expect(before.quotes.every((q) => q.priceCents !== undefined)).toBe(true);
    for (const tierKey of ["aerwell-essential", "aerwell-continuum", "bundled"])
      expect(
        (await client().post(path, { tierKey, status: "active", validUntil: until })).status
      ).toBe(200);
    expect((await client().post(path, { tierKey: "bundled", status: "cancelled" })).status).toBe(
      200
    );
    expect((await stored())?.status).toBe("cancelled");
    expect(await quotes()).toEqual(before.quotes);
    expect(await counts()).toEqual(before.counts);
    expect(before.counts[0]).toBe(0);
  });
});
