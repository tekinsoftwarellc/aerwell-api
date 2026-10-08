import { Types } from "mongoose";

/**
 * Stateless, opaque slot reference, base64url of `0x01 | provider id (12 bytes) | location id
 * (12 bytes) | start in whole seconds (uint32 BE) | service slug (utf8)`. At most about 75
 * characters: Alfred refuses a `slotRef` over 128, and the text form (`v1|slug|ids|ISO`) ran
 * to 139. Nothing is stored, so a ref stays valid exactly as long as the slot stays free (longer
 * than the 15 minutes the contract requires). Booking decodes it and re-validates through the
 * same slot check availability uses; a malformed ref decodes to null and is answered as
 * `SLOT_TAKEN`. Slots sit on a 15-minute grid, so whole seconds lose nothing.
 */
export interface SlotParts {
  slug: string;
  locationId: string;
  providerId: string;
  startAt: Date;
}

const VERSION = 1;
const FIXED_BYTES = 1 + 12 + 12 + 4;

export const encodeSlotRef = (parts: SlotParts): string => {
  const head = Buffer.alloc(FIXED_BYTES);
  head.writeUInt8(VERSION, 0);
  Buffer.from(parts.providerId, "hex").copy(head, 1);
  Buffer.from(parts.locationId, "hex").copy(head, 13);
  head.writeUInt32BE(Math.floor(parts.startAt.getTime() / 1000), 25);
  return Buffer.concat([head, Buffer.from(parts.slug)]).toString("base64url");
};

export function decodeSlotRef(ref: string): SlotParts | null {
  const raw = Buffer.from(ref, "base64url");
  if (raw.length <= FIXED_BYTES || raw.readUInt8(0) !== VERSION) return null;
  const slug = raw.subarray(FIXED_BYTES).toString("utf8");
  const providerId = raw.subarray(1, 13).toString("hex");
  const locationId = raw.subarray(13, 25).toString("hex");
  if (!(Types.ObjectId.isValid(providerId) && Types.ObjectId.isValid(locationId))) return null;
  return { slug, locationId, providerId, startAt: new Date(raw.readUInt32BE(25) * 1000) };
}
