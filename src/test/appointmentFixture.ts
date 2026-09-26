import { vi } from "vitest";
import { Market, MembershipPlan } from "../api/catalog/catalog.model.js";
import { Location } from "../api/location/location.model.js";
import { MemberMembership } from "../api/member/member.model.js";
import { Shift } from "../api/schedule/schedule.model.js";
import { localInstant } from "../api/schedule/time.js";
import { Service } from "../api/service/service.model.js";
import { seedCatalog } from "../api/service/service.seed.js";
import { StaffMember } from "../api/staff/staff.model.js";
import { ORG, memberRow } from "./memberFixture.js";
import { LA, as } from "./scheduleFixture.js";
import { staffFixture } from "./staffFixture.js";

/** Pinned clock (Date only, never timers): every booking below is in its future. */
export const NOW = new Date("2027-03-01T20:00:00.000Z");
export const DAY = "2027-03-10";
export function pinClock(now = NOW) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
}
export const at = (date: string, time: string, tz = LA) => localInstant(date, time, tz);

export async function shiftFor(
  staffId: unknown,
  locationId: unknown,
  date = DAY,
  startTime = "08:00",
  endTime = "17:00",
  tz = LA
) {
  const role = await StaffMember.findById(staffId).select("roleId").lean();
  return Shift.create({
    organizationId: ORG,
    staffId,
    positionRoleId: role?.roleId,
    locationId,
    date,
    startTime,
    endTime,
    startAt: at(date, startTime, tz),
    endAt: at(date, endTime, tz),
    timeZone: tz,
  });
}

/**
 * Seeded client catalog, a Las Vegas clinic in the Las Vegas market, a New
 * York clinic in no market, a medical director (APPOINTMENTS master) and a
 * provider with a shift on DAY in Las Vegas.
 */
export async function bookingWorld() {
  await seedCatalog(ORG);
  const vegas = await Location.create({
    organizationId: ORG,
    name: "Aerwell Las Vegas",
    timeZone: LA,
  });
  const newYork = await Location.create({
    organizationId: ORG,
    name: "Aerwell New York",
    timeZone: "America/New_York",
  });
  await Market.updateOne(
    { organizationId: ORG, slug: "las-vegas" },
    { $set: { locationIds: [vegas._id] } }
  );
  const director = await staffFixture(false, 0);
  const provider = await staffFixture(false, 1);
  await StaffMember.updateOne(
    { _id: provider.staff._id },
    {
      firstName: "Philip",
      lastName: "Diebel",
      titlePrefix: "Dr.",
      isProvider: true,
      accountStatus: "active",
    }
  );
  await shiftFor(provider.staff._id, vegas._id);
  const services = new Map(
    (await Service.find({ organizationId: ORG }).lean()).map((s) => [s.slug ?? "", s])
  );
  const plans = new Map(
    (await MembershipPlan.find({ organizationId: ORG }).lean()).map((p) => [p.slug ?? "", p])
  );
  const service = (slug: string) => {
    const doc = services.get(slug);
    if (!doc) throw new Error(`No seeded service ${slug}`);
    return String(doc._id);
  };
  /** A member holding the given plan slugs from 2027-01-15. */
  async function member(planSlugs: string[] = [], fields: Record<string, unknown> = {}) {
    const row = await memberRow(fields);
    for (const slug of planSlugs)
      await MemberMembership.create({
        organizationId: ORG,
        memberId: row._id,
        planId: plans.get(slug)?._id,
        startedAt: new Date("2027-01-15T08:00:00.000Z"),
      });
    return row;
  }
  const api = as(director.accessToken);
  const booking = (memberId: unknown, slug: string, time = "09:00", extra: object = {}) => ({
    memberId: String(memberId),
    serviceId: service(slug),
    providerId: String(provider.staff._id),
    locationId: String(vegas._id),
    startAt: at(DAY, time).toISOString(),
    ...extra,
  });
  const quoteOf = (body: Record<string, unknown>) => {
    const { providerId: P, idempotencyKey: K, expectedQuote: E, ...rest } = body;
    return api.post("/api/v1/appointments/quote", rest);
  };
  return { vegas, newYork, director, provider, service, plans, member, api, booking, quoteOf };
}
