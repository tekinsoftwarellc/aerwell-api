import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { createServer } from "../../server.js";
import { catalogIds, result } from "../../test/clinicalFixture.js";
import { ORG, client, idOf, memberRow, staffWith } from "../../test/memberFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AuditEvent } from "../audit/audit.js";
import type { MemberDocument } from "../member/member.model.js";
import { UploadRecord } from "../upload/upload.model.js";
import { Biomarker, LabPanelTemplate } from "./catalog.model.js";
import { FULL_PANEL_KEYS } from "./catalog.seed.js";
import { LabPanel } from "./records.model.js";

const sdk = vi.hoisted(() => ({ send: vi.fn(), sign: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = sdk.send;
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
  HeadObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: sdk.sign }));

let app: ReturnType<typeof createServer>;
let admin: ReturnType<typeof client>;
let member: MemberDocument;
let ids: Record<string, string>;
beforeEach(async () => {
  app = createServer();
  admin = client(app, (await staffFixture(true)).accessToken);
  member = await memberRow({ sex: "female", dateOfBirth: "1986-03-02" });
  ids = await catalogIds();
});
afterEach(() => {
  env.AWS_REGION = undefined;
  env.AWS_S3_BUCKET = undefined;
});
const path = (suffix: string, id = idOf(member)) => `/members/${id}${suffix}`;
const panel = (drawnAt: string, results: unknown[], extra: object = {}) =>
  admin.send("post", path("/lab-panels"), { drawnAt, results, ...extra });

describe("biomarker catalog", () => {
  it("seeds the full catalog and three templates idempotently, and edits never touch past results", async () => {
    expect(FULL_PANEL_KEYS).toHaveLength(41);
    await catalogIds();
    expect(await Biomarker.countDocuments({ organizationId: ORG, key: "vitamin_d" })).toBe(1);
    const templates = (await admin.get("/lab-panel-templates")).body.data;
    expect(templates.map((t: { name: string }) => t.name)).toEqual([
      "Female Hormone Panel",
      "Full Panel",
      "Male Hormone Panel",
    ]);
    const full = templates.find((t: { key: string }) => t.key === "full_panel");
    expect(full.biomarkers).toHaveLength(41);
    const lipids = (await admin.get("/biomarkers?category=lipids")).body.data;
    const ldl = lipids.find((b: { key: string }) => b.key === "lipid_panel_standard");
    expect([ldl.normalLabel, ldl.optimalLabel]).toEqual(["< 200", "< 170"]);
    expect(lipids.every((b: { category: string }) => b.category === "lipids")).toBe(true);
    expect((await admin.get("/biomarkers?category=thyroid")).body.data).toHaveLength(6);
    expect(
      (await admin.get("/biomarkers?q=ferritin")).body.data.map((b: { key: string }) => b.key)
    ).toEqual(["iron_tibc_ferritin"]);

    const created = await panel("2026-07-29T16:00:00Z", [result(ids["tsh"], 3.0)]);
    expect(created.body.data.results[0].status).toBe("normal");
    const edited = await admin.send("patch", `/biomarkers/${ids["tsh"]}`, {
      normal: { min: 0.4, max: 2.5 },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.normalLabel).toBe("0.4–2.5");
    const stored = await LabPanel.findById(created.body.data._id).lean();
    expect(stored?.results[0]?.status).toBe("normal");
    const next = await panel("2026-08-29T16:00:00Z", [result(ids["tsh"], 3.0)]);
    expect(next.body.data.results[0].status).toBe("high");
    expect(await AuditEvent.countDocuments({ action: "updated", targetType: "Biomarker" })).toBe(1);
  });
  it("lets only LABS_SCANS master change the catalog", async () => {
    const editor = client(
      app,
      (await staffWith({ MEMBER_RECORDS: "edit", LABS_SCANS: "edit" })).accessToken
    );
    expect((await editor.get("/biomarkers")).status).toBe(200);
    expect((await editor.send("patch", `/biomarkers/${ids["tsh"]}`, { unit: "x" })).status).toBe(
      403
    );
    const body = {
      key: "nmr_particles",
      name: "NMR lipid particle sizes",
      category: "lipids",
      resultType: "categorical",
    };
    expect((await editor.send("post", "/biomarkers", body)).status).toBe(403);
    expect((await admin.send("post", "/biomarkers", body)).status).toBe(201);
    expect((await admin.send("post", "/biomarkers", body)).body.code).toBe("BIOMARKER_KEY_EXISTS");
  });
});

describe("lab panels", () => {
  it("computes status from the catalog and refuses a client-supplied status", async () => {
    const bad = await admin.send("post", path("/lab-panels"), {
      drawnAt: "2026-07-29T16:00:00Z",
      results: [{ biomarkerId: ids["vitamin_d"], value: 22, status: "normal" }],
    });
    expect(bad.status).toBe(400);
    const created = await panel(
      "2026-07-29T16:00:00Z",
      [
        result(ids["vitamin_d"], 22),
        result(ids["lipid_particle_size"], "Pattern C"),
        result(ids["apoe_genotype"], "E3/E3"),
        result(ids["b12_folate"], [612, 14.2]),
        result(ids["lipoprotein_a"], null),
        result(ids["testosterone_total"], 40),
      ],
      { fasting: true, fastingHours: 12, vendor: "Quest Diagnostics" }
    );
    expect(created.status).toBe(201);
    const byKey = Object.fromEntries(
      created.body.data.results.map((r: { key: string }) => [r.key, r])
    );
    expect(byKey["vitamin_d"]).toMatchObject({ status: "low", withinOptimal: false });
    expect(byKey["lipid_particle_size"]).toMatchObject({
      status: "abnormal",
      withinOptimal: false,
    });
    expect(byKey["apoe_genotype"]).toMatchObject({ status: "normal", withinOptimal: true });
    expect(byKey["b12_folate"]).toMatchObject({ status: "normal", withinOptimal: true });
    expect(byKey["lipoprotein_a"]).toMatchObject({ status: null, value: null });
    // No catalog range was printed for the hormone panels: no status is guessed.
    expect(byKey["testosterone_total"]).toMatchObject({ status: null, withinOptimal: null });
    expect(created.body.data.source).toBe("manual");
    expect(created.body.data.reviewStatus).toBe("new");
    const mismatch = await panel("2026-07-29T16:00:00Z", [result(ids["vitamin_d"], "22")]);
    expect([mismatch.status, mismatch.body.code]).toEqual([422, "RESULT_TYPE_MISMATCH"]);
    const dup = await panel("2026-07-29T16:00:00Z", [result(ids["tsh"], 1), result(ids["tsh"], 2)]);
    expect(dup.status).toBe(400);
    expect((await panel("2026-07-29T16:00:00Z", [])).status).toBe(400);
  });
  it("applies the sex-specific range for the member's sex", async () => {
    await Biomarker.updateOne(
      { _id: ids["testosterone_total"] },
      {
        $set: {
          normal: { min: 8, max: 60 },
          sexRanges: { male: { normal: { min: 250, max: 1100 } } },
        },
      }
    );
    const man = await memberRow({ sex: "male" });
    const woman = await panel("2026-07-29T16:00:00Z", [result(ids["testosterone_total"], 40)]);
    const him = await admin.send("post", path("/lab-panels", idOf(man)), {
      drawnAt: "2026-07-29T16:00:00Z",
      results: [result(ids["testosterone_total"], 40)],
    });
    expect(woman.body.data.results[0].status).toBe("normal");
    expect(him.body.data.results[0].status).toBe("low");
  });
  it("takes previous values from the previous panel, counts out of range and filters on both sides", async () => {
    // Inserted out of date order so natural order cannot produce the answer.
    await panel("2026-02-12T16:00:00Z", [result(ids["vitamin_d"], 25), result(ids["tsh"], 2.1)]);
    const latest = await panel("2026-07-29T16:00:00Z", [
      result(ids["hdl_cholesterol"], 58),
      result(ids["vitamin_d"], 22),
      result(ids["tsh"], 1.8),
      result(ids["ggt"], 60),
      result(ids["lipoprotein_a"], null),
    ]);
    await panel("2025-10-03T16:00:00Z", [result(ids["vitamin_d"], 18), result(ids["tsh"], 9)]);
    const detail = (await admin.get(path(`/lab-panels/${latest.body.data._id}`))).body.data;
    const vitD = detail.results.find((r: { key: string }) => r.key === "vitamin_d");
    expect([vitD.previousValue, vitD.deltaPct]).toEqual([25, -12]);
    expect(detail.previousPanel.drawnAt).toBe("2026-02-12T16:00:00.000Z");
    expect(detail).toMatchObject({ markersOrdered: 5, markersTested: 4, outOfRangeCount: 2 });
    // Flagged markers lead the tiles although HDL (an unflagged key marker) was entered first.
    expect(detail.keyMarkers.map((r: { key: string }) => r.key)).toEqual([
      "vitamin_d",
      "ggt",
      "hdl_cholesterol",
    ]);
    const liver = (await admin.get(path(`/lab-panels/${latest.body.data._id}?category=liver`))).body
      .data;
    expect(liver.results.map((r: { key: string }) => r.key)).toEqual(["ggt"]);
    expect(liver.outOfRangeCount).toBe(2);
    const search = (await admin.get(path(`/lab-panels/${latest.body.data._id}?q=vitamin`))).body
      .data;
    expect(search.results.map((r: { key: string }) => r.key)).toEqual(["vitamin_d"]);
    const list = (await admin.get(path("/lab-panels"))).body.data;
    expect(list.map((p: { drawnAt: string }) => p.drawnAt.slice(0, 10))).toEqual([
      "2026-07-29",
      "2026-02-12",
      "2025-10-03",
    ]);
    expect(list[0]).toMatchObject({
      outOfRangeCount: 2,
      notableChange: { name: "Vitamin D", deltaPct: -12 },
    });
    expect(list[1].notableChange).toMatchObject({ name: "Vitamin D", deltaPct: 38.9 });
    expect(list[2].notableChange).toBeNull();
    expect(list[0].results).toBeUndefined();
  });
  it("trends the last five draws oldest first", async () => {
    const dates = [
      "2026-07-29",
      "2025-01-08",
      "2026-02-12",
      "2025-05-20",
      "2024-06-01",
      "2025-10-03",
    ];
    for (const [i, d] of dates.entries())
      await panel(`${d}T16:00:00Z`, [result(ids["hs_crp"], i + 1)]);
    await panel("2026-08-01T16:00:00Z", [result(ids["hs_crp"], null)]);
    const trend = (await admin.get(path(`/biomarkers/${ids["hs_crp"]}/trend?limit=5`))).body.data;
    expect(trend.points.map((p: { value: number }) => p.value)).toEqual([2, 4, 6, 3, 1]);
    expect(trend.normalLabel).toBe("< 3");
    expect((await admin.get(path(`/biomarkers/${ids["hs_crp"]}/trend?limit=6`))).status).toBe(400);
  });
  it("reviews once, adding findings", async () => {
    const created = await panel("2026-07-29T16:00:00Z", [result(ids["tsh"], 1)]);
    const review = path(`/lab-panels/${created.body.data._id}/review`);
    const first = await admin.send("post", review, {
      findings: [{ severity: "info", text: "Synthetic finding" }],
    });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ reviewStatus: "reviewed" });
    expect(first.body.data.findings).toHaveLength(1);
    const again = await admin.send("post", review, {});
    expect([again.status, again.body.code]).toEqual([409, "ALREADY_REVIEWED"]);
    const other = await memberRow();
    expect(
      (await admin.send("post", path(`/lab-panels/${created.body.data._id}/review`, idOf(other))))
        .status
    ).toBe(404);
  });
  it("attaches a verified private PDF once and serves a short-lived link", async () => {
    env.AWS_REGION = "us-east-1";
    env.AWS_S3_BUCKET = "synthetic-private-bucket";
    sdk.send.mockResolvedValue({
      ContentType: "application/pdf",
      ContentLength: 321,
      ServerSideEncryption: "AES256",
    });
    sdk.sign.mockResolvedValue("https://example.invalid/signed");
    const presign = await admin.send("post", "/uploads/presign", {
      purpose: "clinical_document",
      contentType: "application/pdf",
      sizeBytes: 321,
    });
    expect(presign.status).toBe(200);
    const uploadId = presign.body.data.uploadId;
    const created = await panel("2026-07-29T16:00:00Z", [], { documentUploadId: uploadId });
    expect(created.status).toBe(201);
    expect(created.body.data.source).toBe("pdf");
    expect((await UploadRecord.findById(uploadId))?.attachedTo).toBe(
      `LabPanel:${created.body.data._id}`
    );
    const reuse = await admin.send("post", path("/lab-panels", idOf(await memberRow())), {
      drawnAt: "2026-07-29T16:00:00Z",
      documentUploadId: uploadId,
    });
    expect([reuse.status, reuse.body.code]).toEqual([409, "UPLOAD_ALREADY_ATTACHED"]);
    expect(await LabPanel.countDocuments({})).toBe(1);
    const link = await admin.get(path(`/lab-panels/${created.body.data._id}/document`));
    expect(link.body.data.expiresIn).toBe(300);
    expect(await AuditEvent.countDocuments({ action: "downloaded", memberId: idOf(member) })).toBe(
      1
    );
    const nurse = client(
      app,
      (await staffWith({ MEMBER_RECORDS: "edit", LABS_SCANS: "view" })).accessToken
    );
    expect(
      (
        await nurse.send("post", "/uploads/presign", {
          purpose: "clinical_document",
          contentType: "application/pdf",
          sizeBytes: 1,
        })
      ).status
    ).toBe(403);
  });
  it("rejects an unknown template or ordering staff member", async () => {
    const t = await LabPanelTemplate.findOne({ key: "full_panel" });
    expect(
      (await panel("2026-07-29T16:00:00Z", [result(ids["tsh"], 1)], { templateId: String(t?._id) }))
        .status
    ).toBe(201);
    const missing = "0123456789abcdef01234567";
    expect(
      (await panel("2026-07-29T16:00:00Z", [result(ids["tsh"], 1)], { templateId: missing })).status
    ).toBe(404);
    expect(
      (await panel("2026-07-29T16:00:00Z", [result(ids["tsh"], 1)], { orderedById: missing }))
        .status
    ).toBe(404);
    expect((await panel("2026-07-29T16:00:00Z", [result(missing, 1)])).status).toBe(404);
  });
});
