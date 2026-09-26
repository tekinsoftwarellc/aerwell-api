import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../server.js";
import { catalogIds, result } from "../../test/clinicalFixture.js";
import { client, idOf, memberRow, staffWith } from "../../test/memberFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AuditEvent } from "../audit/audit.js";
import type { MemberDocument } from "../member/member.model.js";
import { ClinicalList } from "./records.model.js";
import { setWearablesAdapter } from "./wearables.adapter.js";

let app: ReturnType<typeof createServer>;
let admin: ReturnType<typeof client>;
let member: MemberDocument;
let ids: Record<string, string>;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 2026-09-26 00:30 UTC is still 2026-09-25 in Los Angeles.
  vi.setSystemTime(new Date("2026-09-26T00:30:00Z"));
  app = createServer();
  admin = client(app, (await staffFixture(true)).accessToken);
  member = await memberRow({ sex: "female", dateOfBirth: "1986-09-26" });
  ids = await catalogIds();
});
afterEach(() => {
  vi.useRealTimers();
  setWearablesAdapter(null);
});
const path = (suffix: string, id = idOf(member)) => `/members/${id}${suffix}`;

describe("health summary and scores", () => {
  it("summarises clinician-entered scores, age in the org time zone, labs and DEXA", async () => {
    const empty = (await admin.get(path("/health-summary"))).body.data;
    expect(empty).toMatchObject({ score: null, labs: null, dexa: null, actualAge: 39 });
    await admin.send("post", path("/scores"), { period: "2026-06-01", overallScore: 86 });
    await admin.send("post", path("/scores"), {
      period: "2026-09-01",
      overallScore: 88,
      statusLabel: "Excellent Health",
      biologicalAge: 35,
    });
    await admin.send("post", path("/lab-panels"), {
      drawnAt: "2026-07-29T16:00:00Z",
      nextPanelDue: "2026-10-15",
      results: [result(ids["vitamin_d"], 22), result(ids["tsh"], 1.8)],
    });
    await admin.send("post", path("/scans"), {
      performedAt: "2026-02-12T17:00:00Z",
      metrics: { bodyFatPct: 25.3 },
    });
    await admin.send("post", path("/scans"), {
      performedAt: "2026-08-12T17:00:00Z",
      metrics: { bodyFatPct: 24.1, vatCm2: 68 },
      boneDensity: [{ site: "total_hip_left", tScore: -0.4, classification: "normal" }],
    });
    const summary = (await admin.get(path("/health-summary"))).body.data;
    expect(summary.score).toMatchObject({
      overallScore: 88,
      delta: 2,
      biologicalAge: 35,
      statusLabel: "Excellent Health",
      source: "clinician_entered",
    });
    expect(summary.labs).toMatchObject({
      markersTested: 2,
      outOfRangeCount: 1,
      nextPanelDue: "2026-10-15",
    });
    expect(summary.labs.flagged.map((f: { name: string }) => f.name)).toEqual([
      "Vitamin D, 25-Hydroxy, Total",
    ]);
    expect(summary.dexa.bodyFatPct).toMatchObject({ value: 24.1, delta: -1.2 });
    expect(summary.dexa.boneDensity).toMatchObject({ tScore: -0.4, classification: "normal" });
    expect(
      await AuditEvent.countDocuments({ targetType: "HealthSummary", memberId: idOf(member) })
    ).toBe(2);
  });
  it("filters scores by range on both sides and never computes one", async () => {
    for (const period of ["2025-08-01", "2026-03-01", "2026-06-01", "2026-09-25"])
      await admin.send("post", path("/scores"), { period, overallScore: 80 });
    await admin.send("post", path("/scores"), { period: "2026-12-01", overallScore: 99 });
    const periods = async (range: string) =>
      (await admin.get(path(`/scores?range=${range}`))).body.data.items.map(
        (s: { period: string }) => s.period
      );
    expect(await periods("3m")).toEqual(["2026-09-25"]);
    expect(await periods("6m")).toEqual(["2026-06-01", "2026-09-25"]);
    expect(await periods("1y")).toEqual(["2026-03-01", "2026-06-01", "2026-09-25"]);
    const bad = await admin.send("post", path("/scores"), {
      period: "2026-09-01",
      overallScore: 101,
    });
    expect(bad.status).toBe(400);
    const dup = await admin.send("post", path("/scores"), {
      period: "2026-09-01",
      domainScores: [
        { domain: "metabolic", score: 90 },
        { domain: "metabolic", score: 91 },
      ],
    });
    expect(dup.status).toBe(400);
  });
});

describe("versioned clinical lists", () => {
  it("replaces a list with optimistic versioning and rejects a stale editor", async () => {
    expect((await admin.get(path("/allergies"))).body.data).toMatchObject({
      items: [],
      version: 0,
    });
    const first = await admin.send("put", path("/allergies"), {
      expectedVersion: 0,
      items: [{ name: "Amoxicillin" }, { name: "Peanuts", reaction: "Hives" }],
    });
    expect(first.body.data.version).toBe(1);
    const stale = await admin.send("put", path("/allergies"), { expectedVersion: 0, items: [] });
    expect([stale.status, stale.body.code]).toEqual([409, "VERSION_CONFLICT"]);
    const second = await admin.send("put", path("/allergies"), {
      expectedVersion: 1,
      items: [{ name: "Latex" }],
    });
    expect(second.body.data).toMatchObject({ version: 2, items: [{ name: "Latex" }] });
    expect(await ClinicalList.countDocuments({ kind: "allergies" })).toBe(1);
    for (const [p, item] of [
      ["/goals", { title: "Increase Muscle Mass" }],
      ["/medical-history", { relation: "Mother", condition: "Thyroid Disease" }],
      ["/medications", { name: "Synthetic med", dose: "10 mg", frequency: "Daily" }],
      ["/supplements", { name: "Magnesium", dose: "400 mg" }],
    ] as const) {
      const put = await admin.send("put", path(p), { expectedVersion: 0, items: [item] });
      expect(put.status).toBe(200);
      expect((await admin.get(path(p))).body.data.items).toEqual([item]);
    }
    expect(
      (await admin.send("put", path("/goals"), { expectedVersion: 1, items: [{}] })).status
    ).toBe(400);
    expect(
      await AuditEvent.countDocuments({ targetType: "ClinicalList:allergies", action: "updated" })
    ).toBe(2);
  });
  it("guards lists by module: goals/history/allergies need CLINICAL_NOTES, meds/supps need PROTOCOLS", async () => {
    const notes = client(
      app,
      (await staffWith({ MEMBER_RECORDS: "view", CLINICAL_NOTES: "view" })).accessToken
    );
    expect((await notes.get(path("/allergies"))).status).toBe(200);
    expect(
      (await notes.send("put", path("/allergies"), { expectedVersion: 0, items: [] })).status
    ).toBe(403);
    expect((await notes.get(path("/medications"))).status).toBe(403);
    const protocols = client(
      app,
      (await staffWith({ MEMBER_RECORDS: "view", PROTOCOLS: "edit" })).accessToken
    );
    expect((await protocols.get(path("/supplements"))).status).toBe(200);
    expect((await protocols.get(path("/goals"))).status).toBe(403);
  });
});

describe("wearables read-through", () => {
  it("is unconfigured by default and stores nothing", async () => {
    const res = await admin.get(path("/wearables/summary?metric=sleep"));
    expect(res.body.data).toMatchObject({
      status: "unconfigured",
      from: "2026-09-19",
      to: "2026-09-25",
    });
    expect((await admin.get(path("/wearables/summary?metric=weight"))).status).toBe(400);
  });
  it("reports unlinked members, averages a fake series and hides upstream failures", async () => {
    const read = vi.fn().mockResolvedValue({
      source: "Whoop",
      lastSyncedAt: "2026-09-25T10:00:00Z",
      days: [
        { date: "2026-09-24", activeMinutes: 30, steps: 6000, calories: 400, trainingSessions: 1 },
        { date: "2026-09-25", activeMinutes: 46, steps: 6360, trainingSessions: 2 },
      ],
    });
    setWearablesAdapter({ configured: true, read });
    expect((await admin.get(path("/wearables/summary?metric=activity"))).body.data.status).toBe(
      "unlinked"
    );
    const linked = await memberRow({ alfredAccountId: "acct-synthetic" });
    const ok = (
      await admin.get(path("/wearables/history?metric=activity&from=2026-09-01", idOf(linked)))
    ).body.data;
    expect(ok).toMatchObject({
      status: "ok",
      source: "Whoop",
      averages: { activeMinutes: 38, steps: 6180, calories: 400 },
      trainingLogged: 3,
    });
    expect(read).toHaveBeenCalledWith({
      alfredAccountId: "acct-synthetic",
      metric: "activity",
      from: "2026-09-01",
      to: "2026-09-25",
    });
    setWearablesAdapter({
      configured: true,
      read: () => Promise.reject(new Error("upstream secret detail")),
    });
    const down = await admin.get(path("/wearables/summary?metric=sleep", idOf(linked)));
    expect([down.status, down.body.code]).toEqual([503, "UPSTREAM_UNAVAILABLE"]);
    expect(JSON.stringify(down.body)).not.toContain("secret");
  });
});
