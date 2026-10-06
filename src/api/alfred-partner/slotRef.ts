import { Types } from "mongoose";

/**
 * Stateless, opaque slot reference: base64url of `v1|<service slug>|<location id>|<provider id>|<start ISO>`.
 * Nothing is stored, so a ref stays valid exactly as long as the slot stays free (longer than the
 * 15 minutes the contract requires). Booking decodes it and re-validates through the same slot
 * check availability uses; a malformed ref decodes to null and is answered as `SLOT_TAKEN`.
 */
export interface SlotParts {
  slug: string;
  locationId: string;
  providerId: string;
  startAt: Date;
}

export const encodeSlotRef = (parts: SlotParts): string =>
  Buffer.from(
    ["v1", parts.slug, parts.locationId, parts.providerId, parts.startAt.toISOString()].join("|")
  ).toString("base64url");

export function decodeSlotRef(ref: string): SlotParts | null {
  const [version, slug, locationId, providerId, start, extra] = Buffer.from(ref, "base64url")
    .toString("utf8")
    .split("|");
  const startAt = new Date(start ?? "");
  if (
    version !== "v1" ||
    extra !== undefined ||
    !slug ||
    !(locationId && Types.ObjectId.isValid(locationId)) ||
    !(providerId && Types.ObjectId.isValid(providerId)) ||
    Number.isNaN(startAt.getTime())
  )
    return null;
  return { slug, locationId, providerId, startAt };
}
