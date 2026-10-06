import { expect, it } from "vitest";
import { decodeSlotRef, encodeSlotRef } from "./slotRef.js";

const parts = {
  slug: "dexa-scan",
  locationId: "6710bb4e2f9c1a0031d5e7a2",
  providerId: "6710bb4e2f9c1a0031d5e7a3",
  startAt: new Date("2027-03-10T17:00:00.000Z"),
};
it("round-trips, and is opaque url-safe text", () => {
  const ref = encodeSlotRef(parts);
  expect(ref).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeSlotRef(ref)).toEqual(parts);
});
it("decodes anything malformed, foreign or tampered to null", () => {
  const good = Buffer.from(
    `v1|dexa-scan|${parts.locationId}|${parts.providerId}|2027-03-10T17:00:00.000Z`
  );
  const enc = (s: string) => Buffer.from(s).toString("base64url");
  expect(decodeSlotRef("")).toBeNull();
  expect(decodeSlotRef("not a ref")).toBeNull();
  expect(decodeSlotRef(enc(good.toString().replace("v1|", "v2|")))).toBeNull();
  expect(decodeSlotRef(enc(good.toString().replace(parts.locationId, "nope")))).toBeNull();
  expect(
    decodeSlotRef(enc(good.toString().replace("2027-03-10T17:00:00.000Z", "soon")))
  ).toBeNull();
  expect(decodeSlotRef(enc(`${good.toString()}|extra`))).toBeNull();
  expect(decodeSlotRef(enc("v1|||||"))).toBeNull();
});
