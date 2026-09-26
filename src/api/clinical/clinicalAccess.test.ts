import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import { catalogIds, result } from "../../test/clinicalFixture.js";
import { client, idOf, memberRow, staffWith } from "../../test/memberFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AuditEvent } from "../audit/audit.js";
import type { MemberDocument } from "../member/member.model.js";

let app: ReturnType<typeof createServer>;
let admin: ReturnType<typeof client>;
let member: MemberDocument;
let ids: Record<string, string>;
let panelId: string;
let scanId: string;
let protocolId: string;
beforeEach(async () => {
  app = createServer();
  const fixture = await staffFixture(true);
  admin = client(app, fixture.accessToken);
  member = await memberRow();
  ids = await catalogIds();
  const base = `/members/${idOf(member)}`;
  panelId = (
    await admin.send("post", `${base}/lab-panels`, {
      drawnAt: "2026-07-29T16:00:00Z",
      results: [result(ids["tsh"], 1)],
    })
  ).body.data._id;
  scanId = (
    await admin.send("post", `${base}/scans`, {
      performedAt: "2026-08-12T17:00:00Z",
      metrics: { bodyFatPct: 24 },
    })
  ).body.data._id;
  protocolId = (
    await admin.send("post", `${base}/protocols`, {
      type: "Peptide Protocol",
      name: "Synthetic protocol",
      prescribingProviderId: idOf(fixture.staff),
      startDate: "2026-09-08",
      estEndDate: "2026-11-17",
      items: [
        {
          compound: "BPC-157",
          doseAmount: 250,
          doseUnit: "mcg",
          frequencyCount: 2,
          frequencyPeriod: "weekly",
          route: "subcutaneous",
        },
      ],
    })
  ).body.data._id;
});
const reads = () => {
  const m = `/members/${idOf(member)}`;
  return [
    `${m}/health-summary`,
    `${m}/scores`,
    `${m}/wearables/summary?metric=sleep`,
    `${m}/wearables/history?metric=activity`,
    `${m}/goals`,
    `${m}/medical-history`,
    `${m}/allergies`,
    `${m}/medications`,
    `${m}/supplements`,
    `${m}/lab-panels`,
    `${m}/lab-panels/${panelId}`,
    `${m}/biomarkers/${ids["tsh"]}/trend`,
    `${m}/scans`,
    `${m}/scans/${scanId}`,
    `${m}/scans/metrics/bodyFatPct/trend`,
    `${m}/protocols`,
    `${m}/protocols/${protocolId}`,
    `${m}/protocols/${protocolId}/revisions`,
  ];
};

describe("clinical access", () => {
  it("audits every PHI read with the member id", async () => {
    for (const url of reads()) {
      const before = await AuditEvent.countDocuments({ memberId: idOf(member), action: "viewed" });
      const res = await admin.get(url);
      expect(res.status, url).toBe(200);
      const after = await AuditEvent.countDocuments({ memberId: idOf(member), action: "viewed" });
      expect(after - before, url).toBe(1);
    }
  });
  it("denies front desk every clinical read and write", async () => {
    const frontDesk = client(app, (await staffFixture(false, 4)).accessToken);
    for (const url of reads()) expect((await frontDesk.get(url)).status, url).toBe(403);
    const m = `/members/${idOf(member)}`;
    for (const [method, url] of [
      ["post", `${m}/lab-panels`],
      ["post", `${m}/scans`],
      ["post", `${m}/scores`],
      ["put", `${m}/allergies`],
      ["put", `${m}/medications`],
      ["post", `${m}/protocols`],
      ["patch", `${m}/protocols/${protocolId}`],
    ] as const)
      expect((await frontDesk.send(method, url, {})).status, url).toBe(403);
    expect((await frontDesk.get("/biomarkers")).status).toBe(403);
  });
  it("lets a nurse view protocols but not change them", async () => {
    const nurse = client(app, (await staffFixture(false, 2)).accessToken);
    const m = `/members/${idOf(member)}`;
    expect((await nurse.get(`${m}/protocols`)).status).toBe(200);
    expect((await nurse.get(`${m}/lab-panels`)).status).toBe(200);
    expect(
      (await nurse.send("post", `${m}/protocols/${protocolId}/discontinue`, { reason: "No" }))
        .status
    ).toBe(403);
  });
  it("limits own-scope clinicians to assigned members through the clinical module scope", async () => {
    const own = await staffWith(
      { MEMBER_RECORDS: "edit", LABS_SCANS: "edit", PROTOCOLS: "edit" },
      "own"
    );
    const clinician = client(app, own.accessToken);
    const mine = await memberRow({ assignedClinicianIds: [own.staff._id] });
    expect((await clinician.get(`/members/${idOf(mine)}/lab-panels`)).status).toBe(200);
    expect((await clinician.get(`/members/${idOf(member)}/lab-panels`)).status).toBe(404);
    expect((await clinician.get(`/members/${idOf(member)}/lab-panels/${panelId}`)).status).toBe(
      404
    );
    expect((await clinician.get(`/members/${idOf(member)}/protocols`)).status).toBe(404);
  });
  it("applies the LABS_SCANS own scope even when MEMBER_RECORDS is all", async () => {
    const staff = await staffWith({ MEMBER_RECORDS: "view", LABS_SCANS: "view" });
    const { Role } = await import("../role/role.model.js");
    await Role.updateOne(
      { _id: staff.role._id, "permissions.module": "LABS_SCANS" },
      { $set: { "permissions.$.scope": "own" } }
    );
    const reader = client(app, staff.accessToken);
    expect((await reader.get(`/members/${idOf(member)}`)).status).toBe(200);
    expect((await reader.get(`/members/${idOf(member)}/lab-panels`)).status).toBe(404);
  });
  it("refuses writes on an archived member", async () => {
    const archived = await memberRow({ archivedAt: new Date() });
    const res = await admin.send("post", `/members/${idOf(archived)}/scores`, {
      period: "2026-09-01",
      overallScore: 80,
    });
    expect([res.status, res.body.code]).toEqual([409, "MEMBER_ARCHIVED"]);
    expect((await admin.get(`/members/${idOf(archived)}/scores`)).status).toBe(200);
  });
});
