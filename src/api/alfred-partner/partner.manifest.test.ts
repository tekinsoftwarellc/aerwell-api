import { readFileSync } from "node:fs";
import addFormats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { Location } from "../location/location.model.js";
import { buildManifest, manifestFor } from "./partner.manifest.js";

const schema = JSON.parse(
  readFileSync(new URL("./partner-manifest.schema.json", import.meta.url), "utf8")
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const address = {
  line1: "1 Clinic Way",
  city: "Las Vegas",
  region: "NV",
  postalCode: "89109",
  country: "US",
};
const clientFor = (ids: string[]) => ({
  terms: {
    url: "https://aerwell.example/terms",
    version: "2026-10",
    summary:
      "Aerwell terms covering visits, sample collection and the handling of clinical information.",
  },
  cancellationPolicy: { summary: "Cancel at least 24 hours ahead to keep your visit unit." },
  support: { email: "support@aerwell.example" },
  addresses: Object.fromEntries(ids.map((id) => [id, address])),
});
const vegas = async (extra: Record<string, unknown> = {}) =>
  Location.create({
    organizationId: "org-test",
    name: "Aerwell Las Vegas",
    timeZone: "America/Los_Angeles",
    geo: { type: "Point", coordinates: [-115.17, 36.11] },
    ...extra,
  });

describe("partner manifest builder", () => {
  it("validates against the frozen manifest schema", async () => {
    const location = await vegas();
    const manifest = await manifestFor("org-test", clientFor([String(location._id)]));
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest).toMatchObject({
      audience: "partner-aerwell",
      capabilities: ["services"],
      membershipRequiredByDefault: false,
      cancellationPolicy: { windowHours: 24 },
    });
    expect(manifest.locations[0]).toMatchObject({
      ref: String(location._id),
      timezone: "America/Los_Angeles",
      geo: { type: "Point", coordinates: [-115.17, 36.11] },
    });
    expect(manifest.locations[0]?.hours?.mon).toEqual([{ open: "07:00", close: "19:00" }]);
  });
  it("fails loudly when a location has no coordinates or no street address", async () => {
    const noGeo = await vegas({ geo: undefined, name: "No Geo Clinic" });
    await expect(manifestFor("org-test", clientFor([String(noGeo._id)]))).rejects.toThrow(
      /No Geo Clinic.*geo/
    );
    const noAddress = await vegas({ name: "No Address Clinic" });
    await expect(manifestFor("org-test", clientFor([]))).rejects.toThrow(/address/);
    expect(noAddress).toBeTruthy();
  });
  it("refuses placeholder text, which Alfred rejects", async () => {
    const location = await vegas();
    const client = clientFor([String(location._id)]);
    expect(() =>
      buildManifest([{ ...location.toObject(), _id: location._id } as never], {
        ...client,
        support: { email: "CHANGE ME@aerwell.example" },
      })
    ).toThrow(/CHANGE ME/);
  });
  it("declares the capabilities given in the client values, services by default", async () => {
    const location = await vegas();
    const client = clientFor([String(location._id)]);
    const rows = [{ ...location.toObject(), _id: location._id } as never];
    const clinical = buildManifest(rows, { ...client, capabilities: ["clinical", "services"] });
    expect(clinical.capabilities).toEqual(["clinical", "services"]);
    expect(validate(clinical), JSON.stringify(validate.errors)).toBe(true);
    expect(buildManifest(rows, client).capabilities).toEqual(["services"]);
  });
  it("closed days publish as empty hours", async () => {
    const location = await vegas();
    const hours = location
      .toObject()
      .businessHours.map((h) => (h.weekday === 0 ? { ...h, closed: true } : h));
    const manifest = buildManifest(
      [{ ...location.toObject(), businessHours: hours } as never],
      clientFor([String(location._id)])
    );
    expect(manifest.locations[0]?.hours?.sun).toEqual([]);
    expect(validate(manifest)).toBe(true);
  });
});
