import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import { catalogIds } from "../../test/clinicalFixture.js";
import { client, idOf, memberRow } from "../../test/memberFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AuditEvent } from "../audit/audit.js";
import type { MemberDocument } from "../member/member.model.js";

let app: ReturnType<typeof createServer>;
let admin: ReturnType<typeof client>;
let member: MemberDocument;
beforeEach(async () => {
  app = createServer();
  admin = client(app, (await staffFixture(true)).accessToken);
  member = await memberRow({ sex: "female" });
  await catalogIds();
});
const path = (suffix: string, id = idOf(member)) => `/members/${id}${suffix}`;
const scan = (performedAt: string, metrics: object, extra: object = {}, id = idOf(member)) =>
  admin.send("post", path("/scans", id), { performedAt, metrics, ...extra });

describe("DEXA scans", () => {
  it("records a scan with catalog-derived statuses, regions and transcribed bone density", async () => {
    const created = await scan(
      "2026-08-12T17:00:00Z",
      { bodyFatPct: 24.1, leanMassLb: 108.4, vatCm2: 68, androidGynoidRatio: 0.45 },
      {
        machine: "Hologic Horizon DXA",
        technologist: "R. Alvarez, CBDT",
        regions: [{ region: "total", fatMassLb: 34.3, leanMassLb: 108.4, fatPct: 24.1 }],
        boneDensity: [
          {
            site: "total_hip_left",
            bmdGcm2: 0.94,
            tScore: -0.4,
            zScore: 0.3,
            classification: "normal",
          },
        ],
      }
    );
    expect(created.status).toBe(201);
    const { metrics } = created.body.data;
    // Female healthy range 21-33% is the only body-fat range the design prints.
    expect(metrics.bodyFatPct).toMatchObject({ value: 24.1, status: "normal", unit: "%" });
    expect(metrics.androidGynoidRatio.status).toBe("normal");
    expect(metrics.vatCm2.status).toBeNull();
    const him = await scan(
      "2026-08-12T17:00:00Z",
      { bodyFatPct: 24.1 },
      {},
      idOf(await memberRow({ sex: "male" }))
    );
    expect(him.body.data.metrics.bodyFatPct.status).toBeNull();
    const high = await scan("2026-08-13T17:00:00Z", { bodyFatPct: 35 });
    expect(high.body.data.metrics.bodyFatPct.status).toBe("high");
    const bad = await scan("2026-08-12T17:00:00Z", { bodyFat: 20 });
    expect(bad.status).toBe(400);
    const badSite = await scan("2026-08-12T17:00:00Z", {}, { boneDensity: [{ site: "skull" }] });
    expect(badSite.status).toBe(400);
  });
  it("lists newest first with deltas from the previous scan, trends five and reviews once", async () => {
    const dates = [
      "2026-02-12",
      "2024-08-08",
      "2026-08-12",
      "2025-02-20",
      "2025-08-03",
      "2024-02-01",
    ];
    const fat = [24.9, 27.8, 24.1, 26.5, 25.6, 29];
    for (const [i, d] of dates.entries())
      await scan(`${d}T17:00:00Z`, { bodyFatPct: fat[i], leanMassLb: 100 + i });
    const list = (await admin.get(path("/scans?type=dexa"))).body.data;
    expect(list.map((s: { performedAt: string }) => s.performedAt.slice(0, 10))).toEqual([
      "2026-08-12",
      "2026-02-12",
      "2025-08-03",
      "2025-02-20",
      "2024-08-08",
      "2024-02-01",
    ]);
    expect(list[0].metrics.bodyFatPct.delta).toBe(-0.8);
    expect(list[5].metrics.bodyFatPct.delta).toBeNull();
    expect(list[0].overallStatus).toBe("all_normal");
    const trend = (await admin.get(path("/scans/metrics/bodyFatPct/trend?limit=5"))).body.data;
    expect(trend.points.map((p: { value: number }) => p.value)).toEqual([
      27.8, 26.5, 25.6, 24.9, 24.1,
    ]);
    expect(trend.normalLabel).toBe("21–33");
    expect((await admin.get(path("/scans/metrics/weight/trend"))).status).toBe(400);
    const detail = (await admin.get(path(`/scans/${list[0]._id}`))).body.data;
    expect(detail.previousScan.performedAt.slice(0, 10)).toBe("2026-02-12");
    expect(detail.hasDocument).toBe(false);
    const review = path(`/scans/${list[0]._id}/review`);
    expect((await admin.send("post", review, {})).status).toBe(200);
    expect((await admin.send("post", review, {})).body.code).toBe("ALREADY_REVIEWED");
    expect((await admin.get(path(`/scans/${list[0]._id}/document`))).status).toBe(404);
    expect(
      await AuditEvent.countDocuments({ targetType: "ScanTrend", memberId: idOf(member) })
    ).toBe(1);
  });
});
