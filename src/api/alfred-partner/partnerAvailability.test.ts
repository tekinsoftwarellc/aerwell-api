import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY, at, bookingWorld, pinClock, shiftFor } from "../../test/appointmentFixture.js";
import {
  alfredClient,
  alfredToken,
  installAlfredKeys,
  removeAlfredKeys,
} from "../../test/partnerFixture.js";
import { app } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { Appointment } from "../appointment/appointment.model.js";
import { slotCapacity, slotContext } from "../appointment/availability.service.js";
import { Environment } from "../location/location.model.js";
import { Service } from "../service/service.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { decodeSlotRef } from "./slotRef.js";

beforeEach(() => {
  pinClock();
  installAlfredKeys();
});
afterEach(() => {
  vi.useRealTimers();
  removeAlfredKeys();
});
const ACCOUNT = "6710bb4e2f9c1a0031d5e7a2";
const dayWindow = (day = DAY) => ({
  from: at(day, "00:00").toISOString(),
  to: at(day, "23:59").toISOString(),
});
interface Slot {
  slotRef: string;
  startAt: string;
  endAt: string;
  locationRef: string;
  staffRef: string;
  staffName: string;
  capacityLeft: number;
}
const list = async (itemRef: string, query: Record<string, string> = {}, win = dayWindow()) => {
  const params = new URLSearchParams({ itemRef, accountId: ACCOUNT, ...win, ...query });
  return alfredClient(app).get(`/availability?${params}`);
};
const slotsOf = async (itemRef: string, query: Record<string, string> = {}, win = dayWindow()) => {
  const res = await list(itemRef, query, win);
  expect(res.status).toBe(200);
  return res.body.data.slots as Slot[];
};

describe("GET /availability", () => {
  it("lists the provider's open slots with the contract fields and no price", async () => {
    const w = await bookingWorld();
    const res = await list("dexa-scan");
    const slots = res.body.data.slots as Slot[];
    expect(slots.length).toBeGreaterThan(10);
    expect(slots[0]).toEqual({
      slotRef: expect.any(String),
      startAt: at(DAY, "08:00").toISOString(),
      endAt: expect.any(String),
      locationRef: String(w.vegas._id),
      staffRef: String(w.provider.staff._id),
      staffName: "Dr. Diebel",
      capacityLeft: 1,
    });
    expect(slots.every((s) => !("priceCents" in s))).toBe(true);
    expect(decodeSlotRef(slots[0]?.slotRef ?? "")).toMatchObject({
      slug: "dexa-scan",
      locationId: String(w.vegas._id),
      providerId: String(w.provider.staff._id),
    });
    const times = slots.map((s) => Date.parse(s.startAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("every slot it lists is one the booking check accepts, and a booked slot leaves the list", async () => {
    const w = await bookingWorld();
    const slots = await slotsOf("dexa-scan");
    const first = slots[0] as Slot;
    const last = slots.at(-1) as Slot;
    for (const slot of [first, last]) {
      const member = await w.member(["aerwell-essential"]);
      const booked = await w.api.post("/api/v1/appointments", {
        memberId: String(member._id),
        serviceId: w.service("dexa-scan"),
        providerId: slot.staffRef,
        locationId: slot.locationRef,
        startAt: slot.startAt,
      });
      expect(booked.status).toBe(201);
    }
    const after = (await slotsOf("dexa-scan")).map((s) => s.startAt);
    expect(after).not.toContain(first.startAt);
    expect(after).not.toContain(last.startAt);
  });

  it("DEXA and VO2 only exist in Las Vegas: no slots at a location outside the market", async () => {
    const w = await bookingWorld();
    await shiftFor(w.provider.staff._id, w.newYork._id, DAY, "08:00", "17:00", "America/New_York");
    expect(await slotsOf("dexa-scan", { locationRef: String(w.newYork._id) })).toEqual([]);
    expect(await slotsOf("vo2-max-test", { locationRef: String(w.newYork._id) })).toEqual([]);
    const all = await slotsOf("dexa-scan");
    expect(new Set(all.map((s) => s.locationRef))).toEqual(new Set([String(w.vegas._id)]));
    // A service open in every market does list the New York clinic.
    const blood = await slotsOf("comprehensive-blood-panel");
    expect(new Set(blood.map((s) => s.locationRef))).toEqual(
      new Set([String(w.vegas._id), String(w.newYork._id)])
    );
  });

  it("a virtual service searches every location where a clinician works, each slot naming its own", async () => {
    const w = await bookingWorld();
    expect(
      new Set((await slotsOf("clinician-telehealth-visit")).map((s) => s.locationRef))
    ).toEqual(new Set([String(w.vegas._id)]));
    await shiftFor(w.provider.staff._id, w.newYork._id, DAY, "18:00", "19:00", "America/New_York");
    const both = await slotsOf("clinician-telehealth-visit");
    expect(new Set(both.map((s) => s.locationRef))).toEqual(
      new Set([String(w.vegas._id), String(w.newYork._id)])
    );
  });

  it("filters by staff and answers 404 for a staff member who does not deliver the service", async () => {
    const w = await bookingWorld();
    const other = await staffFixture(false, 1);
    await StaffMember.updateOne(
      { _id: other.staff._id },
      { isProvider: true, accountStatus: "active" }
    );
    await shiftFor(other.staff._id, w.vegas._id);
    const both = await slotsOf("dexa-scan");
    expect(new Set(both.map((s) => s.staffRef))).toEqual(
      new Set([String(w.provider.staff._id), String(other.staff._id)])
    );
    const only = await slotsOf("dexa-scan", { staffRef: String(other.staff._id) });
    expect(new Set(only.map((s) => s.staffRef))).toEqual(new Set([String(other.staff._id)]));
    const missing = await list("dexa-scan", { staffRef: "6710bb4e2f9c1a0031d5e7a3" });
    expect(missing.status).toBe(404);
  });

  describe("one booking at a time per room or machine", () => {
    const setup = async () => {
      const w = await bookingWorld();
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
      const book = async (slug: string, time: string, providerId: unknown) =>
        w.api.post("/api/v1/appointments", {
          memberId: String((await w.member(["aerwell-essential"]))._id),
          serviceId: w.service(slug),
          providerId: String(providerId),
          locationId: String(w.vegas._id),
          startAt: at(DAY, time).toISOString(),
        });
      return { w, second, book };
    };

    it("hides a taken hour in availability for every provider and refuses it in the booking check", async () => {
      const { w, second, book } = await setup();
      expect((await book("dexa-scan", "09:00", w.provider.staff._id)).status).toBe(201);
      const taken = at(DAY, "09:00").getTime();
      const overlaps = (s: Slot) =>
        Date.parse(s.startAt) < taken + 60 * 60_000 && Date.parse(s.endAt) > taken;
      for (const slug of ["dexa-scan", "vo2-max-test"]) {
        const slots = await slotsOf(slug);
        expect(slots.length).toBeGreaterThan(0);
        expect(slots.filter(overlaps)).toEqual([]);
      }
      const refused = await book("vo2-max-test", "09:00", second.staff._id);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("SLOT_UNAVAILABLE");
      // The hour after is free again, and a listed slot books.
      const listed = (await slotsOf("vo2-max-test")).find(
        (s) => s.staffRef === String(second.staff._id)
      );
      expect(listed).toBeDefined();
      expect(
        (
          await book(
            "vo2-max-test",
            at(DAY, "09:00") < new Date(listed?.startAt ?? 0) ? "12:00" : "13:00",
            second.staff._id
          )
        ).status
      ).toBe(201);
    });

    it("two members racing for the machine with different providers: exactly one wins", async () => {
      const { w, second, book } = await setup();
      // Barrier: the first writer waits (up to 2.5 s) for a second one to reach the insert, so that
      // without the environment lock both would pass the room check before either inserts.
      let arrived = 0;
      let release: () => void = () => undefined;
      const both = new Promise<void>((resolve) => {
        release = resolve;
      });
      const real = Appointment.create.bind(Appointment) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(Appointment, "create").mockImplementation(((...args: unknown[]) => {
        arrived += 1;
        if (arrived >= 2) release();
        return Promise.race([both, new Promise((r) => setTimeout(r, 2500))]).then(() =>
          real(...args)
        );
      }) as never);
      const [a, b] = await Promise.all([
        book("dexa-scan", "10:00", w.provider.staff._id),
        book("vo2-max-test", "10:00", second.staff._id),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await Appointment.countDocuments({ startAt: at(DAY, "10:00") })).toBe(1);
    });

    it("a delivery away from the clinic needs no room", async () => {
      const { w } = await setup();
      const service = await Service.findOne({ slug: "dexa-scan" });
      const location = w.vegas;
      const start = at(DAY, "09:00");
      const busy = [
        { startAt: start, endAt: new Date(start.getTime() + 3_600_000), serviceId: "other" },
      ];
      const range = { start: at(DAY, "00:00"), end: at(DAY, "23:00") };
      const ctx = await slotContext(location, service as never, w.provider.staff._id, range);
      const mobile = await slotContext(location, service as never, w.provider.staff._id, range, {
        deliveryMethod: "mobile_phlebotomy",
      });
      expect(slotCapacity({ ...ctx, roomBusy: busy }, start)).toBe(0);
      expect(slotCapacity({ ...mobile, roomBusy: [] }, start)).toBe(1);
      expect(mobile.roomBusy).toEqual([]);
    });
  });

  it("returns correct UTC instants across the spring and autumn clock changes", async () => {
    const w = await bookingWorld();
    for (const date of ["2027-03-13", "2027-03-14", "2027-11-06", "2027-11-07"])
      await shiftFor(w.provider.staff._id, w.vegas._id, date, "08:00", "09:00");
    const spring = await slotsOf(
      "comprehensive-blood-panel",
      {},
      {
        from: "2027-03-13T00:00:00.000Z",
        to: "2027-03-15T00:00:00.000Z",
      }
    );
    // 08:00 local is 16:00Z on PST and 15:00Z on PDT.
    expect(spring.map((s) => s.startAt)).toContain("2027-03-13T16:00:00.000Z");
    expect(spring.map((s) => s.startAt)).toContain("2027-03-14T15:00:00.000Z");
    const autumn = await slotsOf(
      "comprehensive-blood-panel",
      {},
      {
        from: "2027-11-06T00:00:00.000Z",
        to: "2027-11-08T12:00:00.000Z",
      }
    );
    expect(autumn.map((s) => s.startAt)).toContain("2027-11-06T15:00:00.000Z");
    expect(autumn.map((s) => s.startAt)).toContain("2027-11-07T16:00:00.000Z");
  });

  it("answers a 31 day window and refuses longer, backwards or empty ones", async () => {
    const w = await bookingWorld();
    await shiftFor(w.provider.staff._id, w.vegas._id, "2027-03-30", "08:00", "10:00");
    const ok = await slotsOf(
      "comprehensive-blood-panel",
      {},
      {
        from: "2027-03-01T00:00:00.000Z",
        to: "2027-03-31T23:00:00.000Z",
      }
    );
    expect(ok.some((s) => s.startAt.startsWith("2027-03-30"))).toBe(true);
    for (const win of [
      { from: "2027-03-01T00:00:00.000Z", to: "2027-04-02T00:00:00.000Z" },
      { from: "2027-03-10T00:00:00.000Z", to: "2027-03-09T00:00:00.000Z" },
      { from: "2027-03-10T00:00:00.000Z", to: "2027-03-10T00:00:00.000Z" },
    ])
      expect((await list("dexa-scan", {}, win)).status).toBe(400);
  });

  it("an empty window is a valid answer, with the next date that has availability", async () => {
    const w = await bookingWorld();
    await shiftFor(w.provider.staff._id, w.vegas._id, "2027-03-22");
    const res = await list(
      "dexa-scan",
      {},
      {
        from: "2027-03-20T08:00:00.000Z",
        to: "2027-03-21T08:00:00.000Z",
      }
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ slots: [], nextAvailableStartDate: "2027-03-22" });
    const none = await list(
      "dexa-scan",
      {},
      {
        from: "2027-03-25T08:00:00.000Z",
        to: "2027-03-26T08:00:00.000Z",
      }
    );
    expect(none.body.data).toEqual({ slots: [], nextAvailableStartDate: null });
  });

  it("clips slots to the window and never lists a past slot", async () => {
    await bookingWorld();
    const slots = await slotsOf(
      "dexa-scan",
      {},
      {
        from: at(DAY, "10:00").toISOString(),
        to: at(DAY, "11:00").toISOString(),
      }
    );
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(Date.parse(s.startAt)).toBeGreaterThanOrEqual(at(DAY, "10:00").getTime());
      expect(Date.parse(s.endAt)).toBeLessThanOrEqual(at(DAY, "11:00").getTime());
    }
    vi.setSystemTime(at(DAY, "10:30"));
    const later = await slotsOf(
      "dexa-scan",
      {},
      {
        from: at(DAY, "10:00").toISOString(),
        to: at(DAY, "12:00").toISOString(),
      }
    );
    expect(later.every((s) => Date.parse(s.startAt) > at(DAY, "10:30").getTime())).toBe(true);
  });

  it("is 404 for an unknown, inactive or bundle item, and for an unknown location", async () => {
    const w = await bookingWorld();
    expect((await list("nope")).status).toBe(404);
    expect((await list("advanced-assessment")).status).toBe(404);
    expect((await list("dexa-scan", { locationRef: "6710bb4e2f9c1a0031d5e7a3" })).status).toBe(404);
    expect((await list("dexa-scan", { locationRef: "lab-1" })).status).toBe(404);
    await Service.updateOne({ slug: "dexa-scan" }, { status: "inactive" });
    expect((await list("dexa-scan", { locationRef: String(w.vegas._id) })).status).toBe(404);
  });

  it("needs the acting member: 401 without act, 400 for another account, 400 for unknown keys", async () => {
    await bookingWorld();
    const params = new URLSearchParams({
      itemRef: "dexa-scan",
      accountId: ACCOUNT,
      ...dayWindow(),
    });
    const noAct = alfredClient(app, alfredToken({ accountId: null }));
    expect((await noAct.get(`/availability?${params}`)).status).toBe(401);
    params.set("accountId", "6710bb4e2f9c1a0031d5e7a3");
    expect((await alfredClient(app).get(`/availability?${params}`)).status).toBe(400);
    params.set("accountId", ACCOUNT);
    params.set("bogus", "1");
    expect((await alfredClient(app).get(`/availability?${params}`)).status).toBe(400);
  });

  it("does not need a provisioned member: Alfred provisions only at the first order", async () => {
    await bookingWorld();
    expect((await list("dexa-scan")).status).toBe(200);
  });
});
