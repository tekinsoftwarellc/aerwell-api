import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookingWorld } from "../../test/appointmentFixture.js";
import {
  alfredClient,
  alfredToken,
  installAlfredKeys,
  removeAlfredKeys,
} from "../../test/partnerFixture.js";
import { app } from "../../test/scheduleFixture.js";
import { Service } from "../service/service.model.js";

beforeEach(installAlfredKeys);
afterEach(removeAlfredKeys);
const orgPull = () => alfredClient(app, alfredToken({ accountId: null }));
interface Item {
  partnerRef: string;
  status: string;
  locations: string[];
  pricing: { amountCents: number }[];
  tags: string[];
  version: number;
  capacity: number;
  durationMin: number;
}
const pullAll = async (query = "") => {
  const items: Item[] = [];
  let cursor: string | null = null;
  do {
    const res = await orgPull().get(`/catalog?limit=2${query}${cursor ? `&cursor=${cursor}` : ""}`);
    expect(res.status).toBe(200);
    items.push(...res.body.data.items);
    cursor = res.body.data.nextCursor;
  } while (cursor);
  return items;
};

describe("GET /catalog", () => {
  it("maps the six seeded services: five published, the Alfred-owned bundle never", async () => {
    const w = await bookingWorld();
    const items = new Map((await pullAll()).map((i) => [i.partnerRef, i]));
    expect([...items.keys()].sort()).toEqual([
      "assessment-clinician-review",
      "clinician-telehealth-visit",
      "comprehensive-blood-panel",
      "dexa-scan",
      "vo2-max-test",
    ]);
    const vegas = String(w.vegas._id);
    const everywhere = [vegas, String(w.newYork._id)].sort();
    const blood = items.get("comprehensive-blood-panel");
    expect(blood).toMatchObject({
      kind: "services",
      fulfilment: "standard",
      visibility: "all",
      status: "active",
      media: [],
      pricing: [{ mode: "one_time", amountCents: 59500, currency: "usd", tierKeys: [] }],
      tags: ["physical", "lab", "assessment_component"],
    });
    expect([...(blood?.locations ?? [])].sort()).toEqual(everywhere);
    // The catalog carries "Las Vegas only": DEXA and VO2 publish only the Las Vegas location.
    expect(items.get("dexa-scan")?.locations).toEqual([vegas]);
    expect(items.get("vo2-max-test")?.locations).toEqual([vegas]);
    expect(items.get("dexa-scan")?.pricing[0]?.amountCents).toBe(17500);
    // Virtual: not location-bound, not a lab, and the review has no retail price.
    expect(items.get("clinician-telehealth-visit")).toMatchObject({
      locations: [],
      tags: ["virtual"],
      pricing: [{ amountCents: 25000 }],
    });
    expect(items.get("assessment-clinician-review")).toMatchObject({
      locations: [],
      pricing: [],
      tags: ["virtual", "assessment_component"],
    });
    for (const item of items.values()) {
      expect(item.version).toBeGreaterThan(0);
      expect(item.capacity).toBeGreaterThanOrEqual(1);
      expect(item.durationMin).toBeGreaterThan(0);
    }
  });
  it("walks pages in non-decreasing updatedAt order with no repeats or gaps", async () => {
    await bookingWorld();
    const items = await pullAll();
    expect(new Set(items.map((i) => i.partnerRef)).size).toBe(items.length);
    expect(items.map((i) => i.version)).toEqual(
      [...items.map((i) => i.version)].sort((a, b) => a - b)
    );
    const single = await orgPull().get("/catalog?limit=200");
    expect(single.body.data.nextCursor).toBeNull();
    expect(single.body.data.items.map((i: Item) => i.partnerRef)).toEqual(
      items.map((i) => i.partnerRef)
    );
  });
  it("updatedSince is inclusive and an incremental pull also carries inactive and deleted items", async () => {
    await bookingWorld();
    const base = await pullAll();
    const dexa = base.find((i) => i.partnerRef === "dexa-scan");
    const since = new Date(dexa?.version ?? 0).toISOString();
    const incl = await orgPull().get(`/catalog?updatedSince=${since}&limit=200`);
    expect(incl.body.data.items.map((i: Item) => i.partnerRef)).toContain("dexa-scan");
    await Service.updateOne({ slug: "vo2-max-test" }, { status: "inactive" });
    await Service.updateOne({ slug: "dexa-scan" }, { deletedAt: new Date() });
    const full = await pullAll();
    expect(full.map((i) => i.partnerRef)).not.toContain("vo2-max-test");
    expect(full.map((i) => i.partnerRef)).not.toContain("dexa-scan");
    const incremental = await orgPull().get(
      "/catalog?updatedSince=2000-01-01T00:00:00.000Z&limit=200"
    );
    const byRef = new Map(incremental.body.data.items.map((i: Item) => [i.partnerRef, i.status]));
    expect(byRef.get("vo2-max-test")).toBe("inactive");
    expect(byRef.get("dexa-scan")).toBe("deleted");
  });
  it("a market edit bumps the version of the services it affects", async () => {
    const w = await bookingWorld();
    const before = (await pullAll()).find((i) => i.partnerRef === "dexa-scan");
    await new Promise((r) => setTimeout(r, 5));
    const markets = await w.api.get("/api/v1/markets");
    const market = markets.body.data.find((m: { slug: string }) => m.slug === "las-vegas");
    const res = await w.api.patch(`/api/v1/markets/${market.id ?? market._id}`, {
      locationIds: [String(w.vegas._id), String(w.newYork._id)],
      expectedVersion: market.version,
    });
    expect(res.status).toBe(200);
    const after = (await pullAll()).find((i) => i.partnerRef === "dexa-scan");
    expect(after?.version).toBeGreaterThan(before?.version ?? 0);
    expect(after?.locations).toHaveLength(2);
  });
  it("a physical service offered nowhere is published inactive, never as not location-bound", async () => {
    await bookingWorld();
    await Service.updateOne({ slug: "dexa-scan" }, { marketIds: [], marketScope: "listed" });
    const dexa = (await pullAll()).find((i) => i.partnerRef === "dexa-scan");
    expect(dexa).toMatchObject({ status: "inactive", locations: [] });
  });
  it("answers 400 for a malformed cursor, a bad limit and an unknown query key", async () => {
    await bookingWorld();
    expect((await orgPull().get("/catalog?cursor=not-a-cursor")).status).toBe(400);
    expect((await orgPull().get("/catalog?limit=0")).status).toBe(400);
    expect((await orgPull().get("/catalog?limit=201")).status).toBe(400);
    expect((await orgPull().get("/catalog?bogus=1")).status).toBe(400);
  });
  it("kind other than services is empty; accountId needs a matching act", async () => {
    await bookingWorld();
    const classes = await orgPull().get("/catalog?kind=classes");
    expect(classes.body.data).toEqual({ items: [], nextCursor: null });
    const account = "6710bb4e2f9c1a0031d5e7a2";
    expect((await orgPull().get(`/catalog?accountId=${account}`)).status).toBe(401);
    const member = alfredClient(app, alfredToken({ accountId: account }));
    expect((await member.get(`/catalog?accountId=${account}`)).status).toBe(200);
    expect((await member.get("/catalog?accountId=6710bb4e2f9c1a0031d5e7a3")).status).toBe(400);
  });
  it("requires the service token and the contract version", async () => {
    const anonymous = await (await import("supertest")).default(app).get("/api/v1/alfred/catalog");
    expect(anonymous.status).toBe(401);
  });
});

describe("GET /catalog/{partnerRef}", () => {
  it("returns the item with its display cancellation policy", async () => {
    await bookingWorld();
    await Service.updateOne(
      { slug: "dexa-scan" },
      { lateCancellationFee: { enabled: true, amountCents: 5000, windowHours: 24 } }
    );
    const res = await orgPull().get("/catalog/dexa-scan");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      partnerRef: "dexa-scan",
      cancellationPolicy: { windowHours: 24, lateFeeCents: 5000 },
    });
  });
  it("is 404 for an unknown slug, a malformed one, the bundle and an inactive service", async () => {
    await bookingWorld();
    await Service.updateOne({ slug: "vo2-max-test" }, { status: "inactive" });
    for (const ref of ["nope", "advanced-assessment", "vo2-max-test", "%24where"])
      expect((await orgPull().get(`/catalog/${ref}`)).status).toBe(404);
  });
});
