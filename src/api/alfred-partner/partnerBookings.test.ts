import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY, at, pinClock, shiftFor } from "../../test/appointmentFixture.js";
import {
  ACCOUNT,
  alfredClient,
  alfredToken,
  installAlfredKeys,
  removeAlfredKeys,
} from "../../test/partnerFixture.js";
import { NONE_PAID, PAID, partnerWorld } from "../../test/partnerWorld.js";
import { app } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AllowanceLedgerEntry, Appointment } from "../appointment/appointment.model.js";
import { AuditEvent } from "../audit/audit.js";
import { Environment } from "../location/location.model.js";
import { MemberMembership } from "../member/member.model.js";
import { Service } from "../service/service.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { PartnerIdempotencyKey } from "./partnerIdempotency.model.js";

beforeEach(() => {
  pinClock();
  installAlfredKeys();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  removeAlfredKeys();
});

describe("POST /bookings", () => {
  it("books exactly the slot availability listed, and records Alfred's payment without re-pricing", async () => {
    const w = await partnerWorld();
    const slot = await w.slotAt("dexa-scan", "09:00");
    const body = w.bodyFor("dexa-scan", slot, {
      staffRef: slot.staffRef,
      notes: "First scan",
      entitlement: { decision: "retail", quoteRuleVersion: "rv-7" },
      alfredOrderRef: "6710bb4e2f9c1a0031d5e7aa",
      payment: { ...PAID },
    });
    const res = await w.alfred.post("/bookings", body, "book:key:1");
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: "confirmed",
      startAt: slot.startAt,
      endAt: slot.endAt,
      locationRef: String(w.vegas._id),
      staff: { ref: String(w.provider.staff._id), name: "Dr. Diebel" },
      payment: { status: "paid", amountCents: 17500, currency: "usd" },
      summary: { title: "DEXA Scan", locationName: "Aerwell Las Vegas", staffName: "Dr. Diebel" },
    });
    const row = await Appointment.findById(res.body.data.bookingRef).lean();
    expect(row).toMatchObject({
      bookingSource: "alfred_app",
      paymentStatus: "paid_external",
      amountDueCents: 17500,
      alfredOrderRef: "6710bb4e2f9c1a0031d5e7aa",
      acceptedTermsVersion: "2026-10",
      memberNote: "First scan",
      idempotencyKey: "alfred:book:key:1",
      status: "booked",
    });
    expect(row?.price).toMatchObject({
      source: "alfred",
      amountCents: 17500,
      currency: "usd",
      decision: "retail",
      quoteRuleVersion: "rv-7",
      paymentIntentId: "pi_test_123",
    });
    expect(row?.bookedById).toBeUndefined();
    // The listed slot is gone, and the audit trail names the calling service.
    expect((await w.slots("dexa-scan")).map((s) => s.startAt)).not.toContain(slot.startAt);
    const audit = await AuditEvent.findOne({ targetType: "Appointment", action: "created" }).lean();
    expect(audit?.actorId).toBe("partner:alfred-api");
    const read = await w.alfred.get(`/bookings/${res.body.data.bookingRef}`);
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual(res.body.data);
  });

  it("never answers PAYMENT_REQUIRED and never touches Aerwell's own entitlement or ledger", async () => {
    const w = await partnerWorld();
    const plan = await w.member(["aerwell-essential"], {
      alfredAccountId: "6710bb4e2f9c1a0031d5e7b0",
    });
    const planClient = alfredClient(app, alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7b0" }));
    const memberships = await MemberMembership.countDocuments();
    const shapes = [
      { status: "none", amountCents: 0, currency: "usd" },
      { status: "none", amountCents: 17500, currency: "usd" },
      { status: "paid", paymentIntentId: "pi_1", amountCents: 17500, currency: "usd" },
      { status: "paid", paymentIntentId: "pi_2", amountCents: 0, currency: "usd" },
      { status: "none", amountCents: 12000, currency: "eur" },
    ];
    const want = [
      "not_required",
      "pending_external",
      "paid_external",
      "not_required",
      "pending_external",
    ];
    for (const [i, payment] of shapes.entries()) {
      const slot = await w.slotAt("clinician-telehealth-visit", `${9 + i}:00`.padStart(5, "0"));
      const client = i % 2 ? planClient : w.alfred;
      const res = await client.post("/bookings", {
        ...w.bodyFor("clinician-telehealth-visit", slot, { payment }),
        accountId: i % 2 ? "6710bb4e2f9c1a0031d5e7b0" : ACCOUNT,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect((await Appointment.findById(res.body.data.bookingRef).lean())?.paymentStatus).toBe(
        want[i]
      );
    }
    expect(plan).toBeTruthy();
    expect(await AllowanceLedgerEntry.countDocuments()).toBe(0);
    expect(await MemberMembership.countDocuments()).toBe(memberships);
  });

  it("is 400 for a paid booking with no intent, an unpaid one with an intent, and a bad currency", async () => {
    const w = await partnerWorld();
    const slot = await w.slotAt("dexa-scan", "09:00");
    const send = (payment: object) =>
      w.alfred.post("/bookings", w.bodyFor("dexa-scan", slot, { payment }));
    expect((await send({ status: "paid", amountCents: 1, currency: "usd" })).status).toBe(400);
    expect((await send({ ...NONE_PAID, paymentIntentId: "pi_x" })).status).toBe(400);
    expect((await send({ ...NONE_PAID, currency: "USD" })).status).toBe(400);
    expect((await send({ ...NONE_PAID, amountCents: -1 })).status).toBe(400);
    expect(await Appointment.countDocuments()).toBe(0);
  });

  it("ignores unknown top-level keys, so a field Alfred adds later does not refuse a paid booking", async () => {
    const w = await partnerWorld();
    const slot = await w.slotAt("dexa-scan", "09:00");
    const res = await w.alfred.post(
      "/bookings",
      w.bodyFor("dexa-scan", slot, { futureField: { a: 1 }, memberEmail: "never@example.invalid" })
    );
    expect(res.status).toBe(201);
    expect(JSON.stringify(await Appointment.findOne().lean())).not.toContain(
      "never@example.invalid"
    );
  });

  describe("idempotency", () => {
    it("a replay with the same key and body answers the same booking and writes nothing", async () => {
      const w = await partnerWorld();
      const slot = await w.slotAt("dexa-scan", "09:00");
      const body = w.bodyFor("dexa-scan", slot);
      const first = await w.alfred.post("/bookings", body, "same-key-1");
      const again = await w.alfred.post("/bookings", body, "same-key-1");
      expect(again.status).toBe(201);
      expect(again.headers["idempotency-replayed"]).toBe("true");
      expect(again.body).toEqual(first.body);
      expect(await Appointment.countDocuments()).toBe(1);
    });
    it("the same key with a different body is 422 and books nothing more", async () => {
      const w = await partnerWorld();
      const slot = await w.slotAt("dexa-scan", "09:00");
      await w.alfred.post("/bookings", w.bodyFor("dexa-scan", slot), "same-key-2");
      const other = await w.slotAt("dexa-scan", "11:00");
      const res = await w.alfred.post("/bookings", w.bodyFor("dexa-scan", other), "same-key-2");
      expect(res.status).toBe(422);
      expect(res.body.data).toEqual({ code: "IDEMPOTENCY_MISMATCH" });
      expect(await Appointment.countDocuments()).toBe(1);
    });
    it("a retry after the stored answer was lost (crash after commit) does not double-book or refuse", async () => {
      const w = await partnerWorld();
      const slot = await w.slotAt("dexa-scan", "09:00");
      const body = w.bodyFor("dexa-scan", slot);
      const first = await w.alfred.post("/bookings", body, "crash-key");
      await PartnerIdempotencyKey.deleteMany({});
      const retry = await w.alfred.post("/bookings", body, "crash-key");
      expect(retry.status).toBe(201);
      expect(retry.body.data.bookingRef).toBe(first.body.data.bookingRef);
      expect(await Appointment.countDocuments()).toBe(1);
    });
    it("a stored 409 stays a 409 for the same key, even after the slot frees up", async () => {
      const w = await partnerWorld();
      const slot = await w.slotAt("dexa-scan", "09:00");
      const taken = await w.alfred.post("/bookings", w.bodyFor("dexa-scan", slot), "winner");
      const other = await w.member([], { alfredAccountId: "6710bb4e2f9c1a0031d5e7b1" });
      const second = alfredClient(app, alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7b1" }));
      const body = { ...w.bodyFor("dexa-scan", slot), accountId: "6710bb4e2f9c1a0031d5e7b1" };
      const lost = await second.post("/bookings", body, "loser");
      expect(lost.status).toBe(409);
      await Appointment.updateOne({ _id: taken.body.data.bookingRef }, { status: "cancelled" });
      const replay = await second.post("/bookings", body, "loser");
      expect(replay.status).toBe(409);
      expect(replay.body.data).toEqual({ code: "SLOT_TAKEN" });
      expect(other).toBeTruthy();
    });
    it("two identical requests in flight book once; the loser is 503 (outcome unknown), never a 4xx", async () => {
      const w = await partnerWorld();
      const slot = await w.slotAt("dexa-scan", "09:00");
      const body = w.bodyFor("dexa-scan", slot);
      const [a, b] = await Promise.all([
        w.alfred.post("/bookings", body, "race-key"),
        w.alfred.post("/bookings", body, "race-key"),
      ]);
      expect([a.status, b.status].every((s) => s === 201 || s === 503)).toBe(true);
      expect([a, b].some((r) => r.status === 201)).toBe(true);
      expect(await Appointment.countDocuments()).toBe(1);
      const retry = await w.alfred.post("/bookings", body, "race-key");
      expect(retry.status).toBe(201);
      expect(await Appointment.countDocuments()).toBe(1);
    });
    it("a booking that fails after the claim with a 5xx releases the key for a clean retry", async () => {
      const w = await partnerWorld();
      const slot = await w.slotAt("dexa-scan", "09:00");
      const body = w.bodyFor("dexa-scan", slot);
      const create = vi.spyOn(Appointment, "create").mockRejectedValueOnce(new Error("disk full"));
      expect((await w.alfred.post("/bookings", body, "boom")).status).toBe(500);
      create.mockRestore();
      const retry = await w.alfred.post("/bookings", body, "boom");
      expect(retry.status).toBe(201);
      expect(await Appointment.countDocuments()).toBe(1);
    });
  });

  describe("refusals carry Appendix B codes", () => {
    it("SLOT_TAKEN for a slot that went, a garbage ref, a ref for another item, another place or a past time", async () => {
      const w = await partnerWorld();
      const slot = await w.slotAt("dexa-scan", "09:00");
      expect((await w.alfred.post("/bookings", w.bodyFor("dexa-scan", slot))).status).toBe(201);
      const late = await w.alfred.post("/bookings", w.bodyFor("dexa-scan", slot));
      expect(late.status).toBe(409);
      expect(late.body.data).toEqual({ code: "SLOT_TAKEN" });
      for (const bad of [
        w.bodyFor("dexa-scan", { ...slot, slotRef: "garbage" }),
        w.bodyFor("vo2-max-test", slot),
        w.bodyFor("dexa-scan", slot, { locationRef: String(w.newYork._id) }),
        w.bodyFor("dexa-scan", slot, {
          staffRef: String((await staffFixture(false, 1)).staff._id),
        }),
      ]) {
        const res = await w.alfred.post("/bookings", bad);
        expect([res.status, res.body.data?.code]).toEqual([409, "SLOT_TAKEN"]);
      }
    });
    it("SLOT_TAKEN for a time that has already started", async () => {
      const w = await partnerWorld();
      const slot = await w.slotAt("vo2-max-test", "09:00");
      vi.setSystemTime(at(DAY, "10:00"));
      const res = await w.alfred.post("/bookings", w.bodyFor("vo2-max-test", slot));
      expect([res.status, res.body.data?.code]).toEqual([409, "SLOT_TAKEN"]);
    });
    it("SLOT_TAKEN for DEXA in a market where it is not offered, even with a forged ref", async () => {
      const w = await partnerWorld();
      await shiftFor(
        w.provider.staff._id,
        w.newYork._id,
        DAY,
        "08:00",
        "17:00",
        "America/New_York"
      );
      const blood = await w.slotAt("comprehensive-blood-panel", "11:00", DAY, {
        locationRef: String(w.newYork._id),
      });
      const forged = Buffer.from(
        `v1|dexa-scan|${w.newYork._id}|${w.provider.staff._id}|${blood.startAt}`
      ).toString("base64url");
      const res = await w.alfred.post("/bookings", {
        ...w.bodyFor("dexa-scan", blood, { slotRef: forged, locationRef: String(w.newYork._id) }),
      });
      expect([res.status, res.body.data?.code]).toEqual([409, "SLOT_TAKEN"]);
    });
    it("ALREADY_BOOKED when the member already has a booking at that time", async () => {
      const w = await partnerWorld();
      const second = await staffFixture(false, 1);
      await StaffMember.updateOne(
        { _id: second.staff._id },
        { isProvider: true, accountStatus: "active" }
      );
      await shiftFor(second.staff._id, w.vegas._id);
      expect((await w.book("dexa-scan", "09:00")).status).toBe(201);
      // A different clinician is free at 09:00, but the member is not.
      const overlap = await w.slotAt("clinician-telehealth-visit", "09:00", DAY, {
        staffRef: String(second.staff._id),
      });
      const res = await w.alfred.post(
        "/bookings",
        w.bodyFor("clinician-telehealth-visit", overlap)
      );
      expect([res.status, res.body.data?.code]).toEqual([409, "ALREADY_BOOKED"]);
    });
    it("404 for an unknown item, location or staff member, and for a member Alfred never provisioned", async () => {
      const w = await partnerWorld();
      const slot = await w.slotAt("dexa-scan", "09:00");
      const good = w.bodyFor("dexa-scan", slot);
      for (const body of [
        { ...good, itemRef: "nope" },
        { ...good, itemRef: "advanced-assessment" },
        { ...good, locationRef: "6710bb4e2f9c1a0031d5e7a3" },
        { ...good, locationRef: "lab-1" },
        { ...good, staffRef: "6710bb4e2f9c1a0031d5e7a3" },
      ])
        expect((await w.alfred.post("/bookings", body)).status).toBe(404);
      const stranger = alfredClient(app, alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7c9" }));
      expect(
        (await stranger.post("/bookings", { ...good, accountId: "6710bb4e2f9c1a0031d5e7c9" }))
          .status
      ).toBe(404);
    });
    it("400 for another account than the delegation, a malformed body, or a missing terms version", async () => {
      const w = await partnerWorld();
      const slot = await w.slotAt("dexa-scan", "09:00");
      const good = w.bodyFor("dexa-scan", slot);
      expect(
        (await w.alfred.post("/bookings", { ...good, accountId: "6710bb4e2f9c1a0031d5e7a3" }))
          .status
      ).toBe(400);
      const { acceptedTermsVersion, ...noTerms } = good;
      expect(acceptedTermsVersion).toBeTruthy();
      expect((await w.alfred.post("/bookings", noTerms)).status).toBe(400);
      expect((await w.alfred.post("/bookings", { ...good, accountId: "x" })).status).toBe(400);
      expect((await w.alfred.post("/bookings", {})).status).toBe(400);
    });
    it("an archived or unlinked member is a 404", async () => {
      const w = await partnerWorld();
      const slot = await w.slotAt("dexa-scan", "09:00");
      await w.aMember.updateOne({ alfredUnlinkedAt: new Date() });
      expect((await w.alfred.post("/bookings", w.bodyFor("dexa-scan", slot))).status).toBe(404);
    });
  });

  it("one DEXA or VO2 booking at a time per room, through the Alfred path too", async () => {
    const w = await partnerWorld();
    const room = await Environment.create({
      organizationId: "org-test",
      locationId: w.vegas._id,
      name: "The Clinic",
    });
    await Service.updateMany(
      { slug: { $in: ["dexa-scan", "vo2-max-test"] } },
      { environmentId: room._id, locationId: w.vegas._id }
    );
    const second = await staffFixture(false, 1);
    await StaffMember.updateOne(
      { _id: second.staff._id },
      { isProvider: true, accountStatus: "active" }
    );
    await shiftFor(second.staff._id, w.vegas._id);
    const other = await w.member([], { alfredAccountId: "6710bb4e2f9c1a0031d5e7b2" });
    const otherClient = alfredClient(app, alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7b2" }));
    const dexa = await w.slotAt("dexa-scan", "09:00");
    const vo2 = await w.slotAt("vo2-max-test", "09:00", DAY, {
      staffRef: String(second.staff._id),
    });
    expect((await w.alfred.post("/bookings", w.bodyFor("dexa-scan", dexa))).status).toBe(201);
    const refused = await otherClient.post("/bookings", {
      ...w.bodyFor("vo2-max-test", vo2),
      accountId: "6710bb4e2f9c1a0031d5e7b2",
    });
    expect([refused.status, refused.body.data?.code]).toEqual([409, "SLOT_TAKEN"]);
    expect(other).toBeTruthy();
    expect((await w.slots("vo2-max-test")).filter((s) => s.startAt === vo2.startAt)).toEqual([]);
  });

  it("a mobile delivery is accepted only for an active modifier that applies; the address is stored, never returned", async () => {
    const w = await partnerWorld();
    const address = {
      line1: "ADDRESS-SENTINEL-LINE",
      city: "Las Vegas",
      region: "NV",
      postalCode: "89109",
      country: "US",
    };
    const blood = await w.slotAt("comprehensive-blood-panel", "09:00");
    const ok = await w.alfred.post(
      "/bookings",
      w.bodyFor("comprehensive-blood-panel", blood, {
        deliveryMethod: "mobile_phlebotomy",
        serviceAddress: address,
      })
    );
    expect(ok.status).toBe(201);
    expect(JSON.stringify(ok.body)).not.toContain("ADDRESS-SENTINEL-LINE");
    expect(
      JSON.stringify((await w.alfred.get(`/bookings/${ok.body.data.bookingRef}`)).body)
    ).not.toContain("ADDRESS-SENTINEL");
    expect(await Appointment.findById(ok.body.data.bookingRef).lean()).toMatchObject({
      deliveryMethod: "mobile_phlebotomy",
      serviceAddress: { line1: "ADDRESS-SENTINEL-LINE" },
    });
    const dexa = await w.slotAt("dexa-scan", "12:00");
    for (const extra of [
      { deliveryMethod: "mobile_phlebotomy" },
      { deliveryMethod: "teleport" },
      { deliveryMethod: "standard", serviceAddress: address },
      { serviceAddress: address },
    ])
      expect((await w.alfred.post("/bookings", w.bodyFor("dexa-scan", dexa, extra))).status).toBe(
        400
      );
    expect(randomUUID()).toBeTruthy();
  });
});
