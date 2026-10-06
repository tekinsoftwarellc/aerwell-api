import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY, at, pinClock } from "../../test/appointmentFixture.js";
import {
  ACCOUNT,
  alfredClient,
  alfredToken,
  installAlfredKeys,
  removeAlfredKeys,
} from "../../test/partnerFixture.js";
import { PAID, partnerWorld } from "../../test/partnerWorld.js";
import { app } from "../../test/scheduleFixture.js";
import { Appointment } from "../appointment/appointment.model.js";
import { Member } from "../member/member.model.js";
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
const orgPull = () => alfredClient(app, alfredToken({ accountId: null }));
const OTHER = "6710bb4e2f9c1a0031d5e7b7";

describe("GET /orders", () => {
  it("pages every booking of linked members in (updatedAt, _id) order, with cancelled ones, and no one else's", async () => {
    const w = await partnerWorld();
    const unlinked = await w.member([]);
    const staffBooked = await w.api.post("/api/v1/appointments", {
      memberId: String(w.aMember._id),
      serviceId: w.service("clinician-telehealth-visit"),
      providerId: String(w.provider.staff._id),
      locationId: String(w.vegas._id),
      startAt: at(DAY, "14:00").toISOString(),
    });
    expect(staffBooked.status).toBe(422);
    expect((await w.book("dexa-scan", "09:00")).status).toBe(201);
    const cancelled = await w.book("vo2-max-test", "10:00");
    await w.alfred.post(`/bookings/${cancelled.body.data.bookingRef}/cancel`, {});
    await Appointment.create({
      organizationId: "org-test",
      memberId: unlinked._id,
      serviceId: w.service("dexa-scan"),
      categoryId: (await Appointment.findOne().lean())?.categoryId,
      providerId: w.provider.staff._id,
      locationId: w.vegas._id,
      startAt: at(DAY, "15:00"),
      endAt: at(DAY, "16:00"),
      durationMinutes: 60,
      timeZone: "America/Los_Angeles",
      modality: "physical",
      price: {},
      amountDueCents: 0,
      paymentStatus: "not_required",
    });
    const seen: { ref: string; status: string; accountId: string; updatedAt: string }[] = [];
    let cursor: string | null = null;
    do {
      const res = await orgPull().get(`/orders?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.items);
      cursor = res.body.data.nextCursor;
    } while (cursor);
    expect(seen.map((i) => i.status).sort()).toEqual(["cancelled", "confirmed"]);
    expect(seen.every((i) => i.accountId === ACCOUNT)).toBe(true);
    const stamps = seen.map((i) => Date.parse(i.updatedAt));
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(seen[0]).toMatchObject({ kind: "booking" });
  });

  it("carries the booking fields of §5.10, and updatedSince is inclusive", async () => {
    const w = await partnerWorld();
    const made = await w.book("dexa-scan", "09:00", { payment: PAID });
    const res = await orgPull().get("/orders");
    expect(res.body.data.items[0]).toMatchObject({
      kind: "booking",
      ref: made.body.data.bookingRef,
      accountId: ACCOUNT,
      status: "confirmed",
      startAt: at(DAY, "09:00").toISOString(),
      itemRef: "dexa-scan",
      locationRef: String(w.vegas._id),
      payment: { status: "paid", amountCents: 17500, currency: "usd" },
      summary: { title: "DEXA Scan", locationName: "Aerwell Las Vegas" },
    });
    const stamp = res.body.data.items[0].updatedAt;
    expect((await orgPull().get(`/orders?updatedSince=${stamp}`)).body.data.items).toHaveLength(1);
    const after = new Date(Date.parse(stamp) + 1).toISOString();
    expect((await orgPull().get(`/orders?updatedSince=${after}`)).body.data.items).toHaveLength(0);
  });

  it("filters by accountId (needs a matching act), kind, and rejects a bad cursor", async () => {
    const w = await partnerWorld();
    await w.book("dexa-scan", "09:00");
    await w.member([], { alfredAccountId: OTHER });
    const mine = await w.alfred.get(`/orders?accountId=${ACCOUNT}`);
    expect(mine.body.data.items).toHaveLength(1);
    expect((await w.alfred.get(`/orders?accountId=${OTHER}`)).status).toBe(400);
    expect((await orgPull().get(`/orders?accountId=${ACCOUNT}`)).status).toBe(401);
    expect((await orgPull().get("/orders?kind=purchase")).body.data).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await orgPull().get("/orders?kind=booking")).body.data.items).toHaveLength(1);
    expect((await orgPull().get("/orders?cursor=junk")).status).toBe(400);
  });

  it("an unlinked member's bookings leave the stream", async () => {
    const w = await partnerWorld();
    await w.book("dexa-scan", "09:00");
    await Member.updateOne({ _id: w.aMember._id }, { alfredUnlinkedAt: new Date() });
    expect((await orgPull().get("/orders")).body.data.items).toEqual([]);
  });
});

describe("POST /events", () => {
  const event = (type: string, over: Record<string, unknown> = {}) => ({
    idempotencyKey: `evt-${Math.random()}`,
    type,
    occurredAt: "2027-03-02T10:00:00.000Z",
    accountId: ACCOUNT,
    resource: { kind: "order", ref: "x" },
    payload: {},
    ...over,
  });
  const send = (body: object) => orgPull().post("/events", body);

  it("order.paid turns a pending booking paid and records the intent; refunded shows as refunded", async () => {
    const w = await partnerWorld();
    const made = await w.book("dexa-scan", "09:00");
    const ref = made.body.data.bookingRef;
    expect(made.body.data.payment.status).toBe("pending");
    const paid = await send(
      event("order.paid", {
        resource: { kind: "order", ref },
        payload: {
          kind: "booking",
          ref,
          amountCents: 17500,
          currency: "usd",
          paymentIntentId: "pi_live",
          paidAt: "2027-03-02T10:01:00.000Z",
        },
      })
    );
    expect(paid.status).toBe(202);
    expect(paid.body.data).toEqual({ status: "received" });
    expect((await w.alfred.get(`/bookings/${ref}`)).body.data.payment).toEqual({
      status: "paid",
      amountCents: 17500,
      currency: "usd",
    });
    expect((await Appointment.findById(ref).lean())?.externalPayment).toMatchObject({
      paymentIntentId: "pi_live",
    });
    await send(
      event("order.refunded", {
        resource: { kind: "order", ref },
        payload: {
          kind: "booking",
          ref,
          amountCents: 17500,
          currency: "usd",
          refundedAt: "2027-03-03T10:00:00.000Z",
        },
      })
    );
    expect((await w.alfred.get(`/bookings/${ref}`)).body.data.payment.status).toBe("refunded");
    // A late or replayed paid event never moves a refund back to paid.
    await send(
      event("order.paid", { resource: { kind: "order", ref }, payload: { amountCents: 17500 } })
    );
    expect((await w.alfred.get(`/bookings/${ref}`)).body.data.payment.status).toBe("refunded");
  });

  it("the same idempotencyKey answers duplicate and processes nothing twice", async () => {
    const w = await partnerWorld();
    const made = await w.book("dexa-scan", "09:00");
    const ref = made.body.data.bookingRef;
    const body = event("order.paid", {
      idempotencyKey: "dup-1",
      resource: { kind: "order", ref },
      payload: { amountCents: 17500 },
    });
    expect((await send(body)).body.data).toEqual({ status: "received" });
    await Appointment.updateOne({ _id: ref }, { paymentStatus: "pending_external" });
    const dup = await send(body);
    expect([dup.status, dup.body.data]).toEqual([202, { status: "duplicate" }]);
    expect((await Appointment.findById(ref).lean())?.paymentStatus).toBe("pending_external");
  });

  it("an unknown booking, or one that belongs to another account, is still 202 and changes nothing", async () => {
    const w = await partnerWorld();
    const made = await w.book("dexa-scan", "09:00");
    const ref = made.body.data.bookingRef;
    expect(
      (
        await send(
          event("order.paid", { resource: { kind: "order", ref: "6710bb4e2f9c1a0031d5e7ff" } })
        )
      ).status
    ).toBe(202);
    expect(
      (await send(event("order.paid", { resource: { kind: "order", ref: "nope" } }))).status
    ).toBe(202);
    await w.member([], { alfredAccountId: OTHER });
    const wrong = await send(
      event("order.paid", {
        accountId: OTHER,
        resource: { kind: "order", ref },
        payload: { amountCents: 1 },
      })
    );
    expect(wrong.status).toBe(202);
    expect((await Appointment.findById(ref).lean())?.paymentStatus).toBe("pending_external");
  });

  it("member.deleted unlinks and deletes nothing; bookings then answer 404", async () => {
    const w = await partnerWorld();
    const made = await w.book("dexa-scan", "09:00");
    const res = await send(
      event("member.deleted", {
        resource: { kind: "member", ref: "m" },
        payload: { accountId: ACCOUNT },
      })
    );
    expect(res.status).toBe(202);
    const member = await Member.findById(w.aMember._id).lean();
    expect(member?.alfredUnlinkedAt).toBeTruthy();
    expect(member?.firstName).toBeTruthy();
    expect(await Appointment.countDocuments()).toBe(1);
    expect((await w.alfred.get(`/bookings/${made.body.data.bookingRef}`)).status).toBe(404);
  });

  it("member.provisioned is accepted with no change; an unknown type is 400", async () => {
    await partnerWorld();
    expect(
      (await send(event("member.provisioned", { resource: { kind: "member", ref: "m" } }))).status
    ).toBe(202);
    expect((await send(event("booking.created"))).status).toBe(400);
    expect((await send({ ...event("order.paid"), idempotencyKey: "" })).status).toBe(400);
    expect((await send({ ...event("order.paid"), extra: 1 })).status).toBe(400);
  });

  it("a handler failure releases the key so Alfred's retry is processed", async () => {
    const w = await partnerWorld();
    const made = await w.book("dexa-scan", "09:00");
    const ref = made.body.data.bookingRef;
    const body = event("order.paid", {
      idempotencyKey: "retry-1",
      resource: { kind: "order", ref },
      payload: { amountCents: 17500 },
    });
    vi.spyOn(Appointment, "updateOne").mockRejectedValueOnce(new Error("db down"));
    expect((await send(body)).status).toBe(500);
    expect(await PartnerIdempotencyKey.countDocuments({ key: "retry-1" })).toBe(0);
    const retry = await send(body);
    expect(retry.body.data).toEqual({ status: "received" });
    expect((await Appointment.findById(ref).lean())?.paymentStatus).toBe("paid_external");
  });
});
