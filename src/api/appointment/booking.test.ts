import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DAY, at, bookingWorld, pinClock, shiftFor } from "../../test/appointmentFixture.js";
import { ORG } from "../../test/memberFixture.js";
import { as } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { MembershipPlan } from "../catalog/catalog.model.js";
import { PtoRequest } from "../schedule/schedule.model.js";
import { Service } from "../service/service.model.js";
import { AllowanceLedgerEntry, Appointment } from "./appointment.model.js";
import { ledger } from "./ledger.service.js";

beforeEach(() => pinClock());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const quoted = (body: { data: { finalCents: number; ruleVersion: string } }) => ({
  finalCents: body.data.finalCents,
  ruleVersion: body.data.ruleVersion,
});

it("books an included telehealth visit from the real allowance, snapshots the quote and reserves one unit", async () => {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-essential"]);
  const body = w.booking(member._id, "clinician-telehealth-visit");
  const q = await w.quoteOf(body);
  expect(q.status).toBe(200);
  expect(q.body.data).toMatchObject({
    kind: "appointment",
    bookable: true,
    decision: "allowance",
    finalCents: 0,
    allowance: { limit: 2, usedBefore: 0, remainingAfter: 1 },
  });
  expect(q.body.data.ruleVersion).toContain("plan:");
  expect(new Date(q.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
  const booked = await w.api.post("/api/v1/appointments", {
    ...body,
    expectedQuote: quoted(q.body),
  });
  expect(booked.status).toBe(201);
  const appointment = booked.body.data.appointment;
  expect(appointment).toMatchObject({
    status: "booked",
    amountDueCents: 0,
    paymentStatus: "not_required",
    durationMinutes: 60,
    endAt: at(DAY, "10:00").toISOString(),
  });
  expect(appointment.price).toMatchObject({ decision: "allowance", finalCents: 0 });
  expect(appointment.price.candidates).toBeUndefined();
  const rows = await AllowanceLedgerEntry.find({ memberId: member._id }).lean();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "reserved", holding: true, quantity: 1 });
  expect(String(rows[0]?.appointmentId)).toBe(appointment._id);
  // The next quote sees the reservation.
  const next = await w.quoteOf(w.booking(member._id, "clinician-telehealth-visit", "11:00"));
  expect(next.body.data.allowance).toMatchObject({ usedBefore: 1, remainingAfter: 0 });
  expect(await AuditEvent.exists({ targetType: "Appointment", action: "created" })).toBeTruthy();
});

it("denies by the evaluator's reason and never books: Free Everhaus, New York DEXA, bundles", async () => {
  const w = await bookingWorld();
  const free = await w.member();
  const red = await w.api.post("/api/v1/appointments", w.booking(free._id, "red-light-therapy"));
  expect(red.status).toBe(422);
  expect(red.body.code).toBe("NOT_ELIGIBLE");
  const ny = await w.quoteOf({
    ...w.booking(free._id, "dexa-scan"),
    locationId: String(w.newYork._id),
  });
  expect(ny.body.data).toMatchObject({ bookable: false, denialReason: "MARKET_UNAVAILABLE" });
  const bundle = await w.api.post(
    "/api/v1/appointments",
    w.booking(free._id, "advanced-assessment")
  );
  expect(bundle.body.code).toBe("BUNDLE_REQUIRES_EPISODE");
  const retail = await w.quoteOf(
    w.booking(free._id, "comprehensive-blood-panel", "09:00", {
      deliveryMethod: "mobile_phlebotomy",
    })
  );
  expect(retail.body.data).toMatchObject({
    decision: "retail",
    finalCents: 71500,
    feesCents: 12000,
  });
  expect(await Appointment.countDocuments()).toBe(0);
});

it("keeps the booked price snapshot when the plan changes, and refuses a stale quote", async () => {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-continuum"]);
  const body = w.booking(member._id, "red-light-therapy");
  const q = await w.quoteOf(body);
  expect(q.body.data.finalCents).toBe(4800);
  const booked = await w.api.post("/api/v1/appointments", {
    ...body,
    expectedQuote: quoted(q.body),
  });
  expect(booked.status).toBe(201);
  const plan = w.plans.get("aerwell-continuum");
  const benefits = (plan?.benefits ?? []).map((b) =>
    String(b.serviceId) === w.service("red-light-therapy")
      ? { ...b, pricing: { mode: "discount", discountBps: 5000 } }
      : b
  );
  await MembershipPlan.updateOne({ _id: plan?._id }, { $set: { benefits }, $inc: { version: 1 } });
  const detail = await w.api.get(`/api/v1/appointments/${booked.body.data.appointment._id}`);
  expect(detail.body.data.price.finalCents).toBe(4800);
  expect(detail.body.data.membership.name).toBe("Aerwell Continuum");
  // Same stale quote on a new booking: the server re-evaluates and refuses.
  const stale = await w.api.post("/api/v1/appointments", {
    ...w.booking(member._id, "red-light-therapy", "11:00"),
    expectedQuote: quoted(q.body),
  });
  expect(stale.status).toBe(409);
  expect(stale.body.code).toBe("QUOTE_CHANGED");
  expect(stale.body.data.quote.finalCents).toBe(3000);
});

it("replays an idempotency key, refuses its reuse and never double-books under concurrency", async () => {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-essential"]);
  const body = {
    ...w.booking(member._id, "clinician-telehealth-visit"),
    idempotencyKey: "key-12345678",
  };
  const [a, b] = await Promise.all([
    w.api.post("/api/v1/appointments", body),
    w.api.post("/api/v1/appointments", body),
  ]);
  expect([a.status, b.status]).toEqual([201, 201]);
  expect(a.body.data.appointment._id).toBe(b.body.data.appointment._id);
  expect([a.body.data.replayed, b.body.data.replayed].sort()).toEqual([false, true]);
  expect(await Appointment.countDocuments()).toBe(1);
  expect(await AllowanceLedgerEntry.countDocuments()).toBe(1);
  const reused = await w.api.post("/api/v1/appointments", {
    ...body,
    startAt: at(DAY, "13:00").toISOString(),
  });
  expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
});

it("re-validates the slot: shift, business hours, PTO, overlap, grid, member clash, eligibility", async () => {
  const w = await bookingWorld();
  const member = await w.member();
  const other = await w.member();
  const book = (m: unknown, time: string, extra: object = {}) =>
    w.api.post("/api/v1/appointments", w.booking(m, "clinician-telehealth-visit", time, extra));
  expect((await book(member._id, "07:30")).body.code).toBe("SLOT_UNAVAILABLE"); // before shift
  expect((await book(member._id, "16:30")).body.code).toBe("SLOT_UNAVAILABLE"); // ends after shift
  expect((await book(member._id, "09:10")).body.code).toBe("SLOT_NOT_ALIGNED");
  expect((await book(member._id, "09:00")).status).toBe(201);
  expect((await book(other._id, "09:30")).body.code).toBe("SLOT_UNAVAILABLE"); // provider busy
  expect(
    (await book(member._id, "10:00", { providerId: String(w.director.staff._id) })).body.code
  ).toBe("PROVIDER_NOT_ELIGIBLE");
  expect((await book(other._id, "10:00")).status).toBe(201); // adjacent edge is free
  // Member clash with another provider.
  const second = await staffFixture(false, 1);
  const { StaffMember } = await import("../staff/staff.model.js");
  await StaffMember.updateOne({ _id: second.staff._id }, { isProvider: true });
  await shiftFor(second.staff._id, w.vegas._id);
  expect(
    (await book(member._id, "09:30", { providerId: String(second.staff._id) })).body.code
  ).toBe("MEMBER_DOUBLE_BOOKED");
  // Approved PTO blocks the whole day even though the shift still exists.
  await PtoRequest.create({
    organizationId: ORG,
    staffId: second.staff._id,
    startDate: DAY,
    endDate: DAY,
    days: 1,
    type: "vacation",
    status: "approved",
  });
  expect((await book(other._id, "13:00", { providerId: String(second.staff._id) })).body.code).toBe(
    "SLOT_UNAVAILABLE"
  );
  // Location hours clip a shift that starts before opening.
  await shiftFor(w.provider.staff._id, w.vegas._id, "2027-03-11", "06:00", "09:00");
  const early = w.booking(member._id, "clinician-telehealth-visit", "06:00", {
    startAt: at("2027-03-11", "06:00").toISOString(),
  });
  expect((await w.api.post("/api/v1/appointments", early)).body.code).toBe("SLOT_UNAVAILABLE");
  const open = { ...early, startAt: at("2027-03-11", "07:00").toISOString() };
  expect((await w.api.post("/api/v1/appointments", open)).status).toBe(201);
});

it("lets a group service fill up to capacityMax in one slot", async () => {
  const w = await bookingWorld();
  await Service.updateOne({ _id: w.service("everhaus-training") }, { capacityMax: 2 });
  const [a, b, c] = [
    await w.member(["everhaus-member"]),
    await w.member(["everhaus-member"]),
    await w.member(["everhaus-member"]),
  ];
  const book = (m: unknown) =>
    w.api.post("/api/v1/appointments", w.booking(m, "everhaus-training"));
  expect((await book(a._id)).status).toBe(201);
  expect((await book(b._id)).status).toBe(201);
  expect((await book(c._id)).body.code).toBe("SLOT_UNAVAILABLE");
});

it("own-scope staff can only book themselves; permissions are enforced", async () => {
  const w = await bookingWorld();
  const member = await w.member();
  const { Role } = await import("../role/role.model.js");
  const role = await Role.findById(w.provider.role._id).lean();
  await Role.updateOne(
    { _id: w.provider.role._id },
    {
      $set: {
        permissions: role?.permissions.map((p) =>
          p.module === "APPOINTMENTS" ? { ...p, scope: "own" } : p
        ),
      },
    }
  );
  const self = as(w.provider.accessToken);
  const otherProvider = await self.post(
    "/api/v1/appointments",
    w.booking(member._id, "clinician-telehealth-visit", "09:00", {
      providerId: String(w.director.staff._id),
    })
  );
  expect(otherProvider.status).toBe(403);
  const mine = await self.post(
    "/api/v1/appointments",
    w.booking(member._id, "clinician-telehealth-visit")
  );
  expect(mine.status).toBe(201);
  const noAccess = await staffFixture(false, 1);
  await Role.updateOne(
    { _id: noAccess.role._id },
    { $set: { "permissions.$[p].level": "view" } },
    { arrayFilters: [{ "p.module": "APPOINTMENTS" }] }
  );
  const viewer = as(noAccess.accessToken);
  expect(
    (
      await viewer.post(
        "/api/v1/appointments",
        w.booking(member._id, "clinician-telehealth-visit", "11:00")
      )
    ).status
  ).toBe(403);
  expect(
    (
      await viewer.post("/api/v1/appointments/quote", {
        ...w.booking(member._id, "clinician-telehealth-visit"),
        providerId: undefined,
      })
    ).status
  ).toBe(200);
});

it("serializes concurrent last-unit bookings: only one writer ever attempts the final unit", async () => {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-essential"]);
  const first = w.booking(member._id, "clinician-telehealth-visit", "09:00");
  expect((await w.api.post("/api/v1/appointments", first)).status).toBe(201);
  // Both writers were quoted the last unit at $0.
  const q = await w.quoteOf(w.booking(member._id, "clinician-telehealth-visit", "11:00"));
  expect(q.body.data.allowance.remainingAfter).toBe(0);
  const attempts: number[] = [];
  const reserve = ledger.reserve.bind(ledger);
  vi.spyOn(ledger, "reserve").mockImplementation(async (input, session) => {
    attempts.push(input.allowance.usedBefore);
    return reserve(input, session);
  });
  // Barrier: the first reader waits for a second reader (or 300 ms) so that,
  // without the member lock, both would count usage before either reserves.
  let readers = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const usage = ledger.usage.bind(ledger);
  vi.spyOn(ledger, "usage").mockImplementation(async (...args) => {
    const result = await usage(...args);
    readers += 1;
    if (readers >= 2) release();
    await Promise.race([gate, new Promise((r) => setTimeout(r, 300))]);
    return result;
  });
  // Different providers, so only the MEMBER lock can serialize the two writers.
  const second = await staffFixture(false, 1);
  const { StaffMember } = await import("../staff/staff.model.js");
  await StaffMember.updateOne({ _id: second.staff._id }, { isProvider: true });
  await shiftFor(second.staff._id, w.vegas._id);
  const results = await Promise.all(
    [
      ["11:00", String(w.provider.staff._id)],
      ["13:00", String(second.staff._id)],
    ].map(([time, providerId]) =>
      w.api.post("/api/v1/appointments", {
        ...w.booking(member._id, "clinician-telehealth-visit", time, { providerId }),
        expectedQuote: quoted(q.body),
      })
    )
  );
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(results.find((r) => r.status === 409)?.body.code).toBe("QUOTE_CHANGED");
  // What each writer ATTEMPTED: the final unit (usedBefore 1) was tried exactly once.
  expect(attempts).toEqual([1]);
  expect(await AllowanceLedgerEntry.countDocuments({ memberId: member._id, holding: true })).toBe(
    2
  );
});
