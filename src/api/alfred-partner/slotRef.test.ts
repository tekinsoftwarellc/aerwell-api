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
it("stays under Alfred's 128-character limit for the longest service slug", () => {
  const ref = encodeSlotRef({ ...parts, slug: "assessment-clinician-review" });
  expect(ref.length).toBeLessThanOrEqual(128);
  expect(decodeSlotRef(ref)?.slug).toBe("assessment-clinician-review");
});
it("decodes anything malformed, foreign or tampered to null", () => {
  const good = Buffer.from(encodeSlotRef(parts), "base64url");
  const enc = (b: Buffer) => b.toString("base64url");
  expect(decodeSlotRef("")).toBeNull();
  expect(decodeSlotRef("not a ref")).toBeNull();
  expect(decodeSlotRef(enc(good.subarray(0, 29)))).toBeNull(); // no slug
  expect(decodeSlotRef(enc(Buffer.concat([Buffer.from([2]), good.subarray(1)])))).toBeNull();
  expect(
    decodeSlotRef(Buffer.from("v1|dexa-scan|a|b|2027-03-10T17:00:00.000Z").toString("base64url"))
  ).toBeNull();
});
