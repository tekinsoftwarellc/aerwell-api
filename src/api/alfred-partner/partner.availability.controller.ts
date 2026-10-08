import type { Request, Response } from "express";
import type { z } from "zod";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../../common/errors/AppError.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { env } from "../../config/env.js";
import {
  eligibleProviders,
  openSlots,
  providerName,
  slotContext,
} from "../appointment/availability.service.js";
import { Location } from "../location/location.model.js";
import { Shift } from "../schedule/schedule.model.js";
import { todayIn } from "../schedule/time.js";
import { Service } from "../service/service.model.js";
import { loadCatalogContext, offeredLocations } from "./catalogItem.js";
import type { availabilityQuery } from "./partner.schema.js";
import { encodeSlotRef } from "./slotRef.js";

const DAY_MS = 86_400_000;
const MAX_WINDOW_DAYS = 31;
const NEXT_PROBE_DAYS = 14;
type Row = {
  slotRef: string;
  startAt: Date;
  endAt: Date;
  locationRef: string;
  staffRef: string;
  staffName: string;
  capacityLeft: number;
  tz: string;
};

/** The service Alfred names by slug; unknown, inactive, deleted and the Alfred-owned bundle are 404. */
export async function publishedService(organizationId: string, slug: string) {
  const service = await Service.findOne({
    organizationId,
    slug,
    status: "active",
    deletedAt: null,
    "bundleComponentIds.0": { $exists: false },
  });
  if (!service) throw new NotFoundError("Unknown catalogue item");
  return service;
}

/** Locations to search: the one asked for, else where the service is offered (virtual: where clinicians work). */
async function searchLocations(
  organizationId: string,
  service: Awaited<ReturnType<typeof publishedService>>,
  providerIds: unknown[],
  window: { start: Date; end: Date },
  locationRef?: string
) {
  const offered = offeredLocations(service, await loadCatalogContext(organizationId));
  if (locationRef) {
    const location = typesIsValid(locationRef)
      ? await Location.findOne({ _id: locationRef, organizationId })
      : null;
    if (!location) throw new NotFoundError("Unknown location");
    // A listed service has no slots outside its markets; a virtual one has no location rule.
    return service.modality === "virtual" || offered.includes(String(location._id))
      ? [location]
      : [];
  }
  if (service.modality !== "virtual")
    return Location.find({ organizationId, _id: { $in: offered } });
  const worked = await Shift.distinct("locationId", {
    organizationId,
    staffId: { $in: providerIds },
    startAt: { $lt: window.end },
    endAt: { $gt: window.start },
  });
  return Location.find({ organizationId, _id: { $in: worked } });
}
const typesIsValid = (id: string) => /^[a-f\d]{24}$/i.test(id);

async function slotsIn(
  service: Awaited<ReturnType<typeof publishedService>>,
  locations: Awaited<ReturnType<typeof searchLocations>>,
  providers: Awaited<ReturnType<typeof eligibleProviders>>,
  range: { start: Date; end: Date }
): Promise<Row[]> {
  const grid = locations.flatMap((location) =>
    providers.map((provider) => ({ location, provider }))
  );
  const rows = await Promise.all(
    grid.map(async ({ location, provider }) => {
      const ctx = await slotContext(location, service, provider._id, range);
      return openSlots(ctx).map((slot) => ({
        slotRef: encodeSlotRef({
          slug: service.slug ?? "",
          locationId: String(location._id),
          providerId: String(provider._id),
          startAt: slot.startAt,
        }),
        startAt: slot.startAt,
        endAt: slot.endAt,
        locationRef: String(location._id),
        staffRef: String(provider._id),
        staffName: providerName(provider),
        capacityLeft: slot.remaining,
        tz: location.timeZone ?? "America/Los_Angeles",
      }));
    })
  );
  return rows.flat();
}

/**
 * `GET /availability` (§5.5). Slots come from the same computation the booking check runs
 * (`slotContext` and `openSlots`), so a slot listed here is a slot booking accepts. No price:
 * Alfred prices. An empty list is a valid answer.
 */
export async function getAvailability(req: Request, res: Response): Promise<void> {
  const q = req.query as unknown as z.output<typeof availabilityQuery>;
  if (!env.AERWELL_ORG_ID) throw new UnauthorizedError("Partner organization is not configured");
  if (q.accountId !== req.partner?.accountId)
    throw new BadRequestError("accountId must match the acting member");
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (to <= from || to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS)
    throw new BadRequestError(`Choose a window of up to ${MAX_WINDOW_DAYS} days, from before to`);
  const organizationId = env.AERWELL_ORG_ID;
  const service = await publishedService(organizationId, q.itemRef);
  const providers = await eligibleProviders(service, q.staffRef);
  if (q.staffRef && !providers.length) throw new NotFoundError("Unknown staff member");
  const providerIds = providers.map((p) => p._id);
  const range = { start: from, end: to };
  const locations = await searchLocations(
    organizationId,
    service,
    providerIds,
    range,
    q.locationRef
  );
  const found = await slotsIn(service, locations, providers, range);
  const slots = found
    // Clipped to the window the caller asked for.
    .filter((s) => s.startAt >= from && s.endAt <= to)
    .sort(
      (a, b) =>
        a.startAt.getTime() - b.startAt.getTime() ||
        a.staffName.localeCompare(b.staffName) ||
        a.locationRef.localeCompare(b.locationRef)
    );
  const probe = { start: to, end: new Date(to.getTime() + NEXT_PROBE_DAYS * DAY_MS) };
  const [next] = (await slotsIn(service, locations, providers, probe)).sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime()
  );
  res.json(
    ServiceResponse.success("Availability", {
      slots: slots.map(({ tz, ...slot }) => slot),
      nextAvailableStartDate: next ? todayIn(next.tz, next.startAt) : null,
    })
  );
}
