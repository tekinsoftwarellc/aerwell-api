import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { pinClock } from "../../test/appointmentFixture.js";
import { catalogIds, result } from "../../test/clinicalFixture.js";
import { client, idOf } from "../../test/memberFixture.js";
import {
  ACCOUNT,
  alfredClient,
  alfredToken,
  installAlfredKeys,
  removeAlfredKeys,
} from "../../test/partnerFixture.js";
import { partnerWorld } from "../../test/partnerWorld.js";
import { app } from "../../test/scheduleFixture.js";
import { Appointment } from "../appointment/appointment.model.js";
import { LabPanel, Scan } from "../clinical/records.model.js";
import { Service } from "../service/service.model.js";
import { UploadRecord } from "../upload/upload.model.js";
import { PartnerOutbox } from "./outbox/partnerOutbox.model.js";

const sdk = vi.hoisted(() => ({ send: vi.fn(), sign: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = sdk.send;
  },
  PutObjectCommand: class {},
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
  HeadObjectCommand: class {},
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: sdk.sign }));

// A result value that must never appear in a response, an event or a log line.
const SENTINEL = 91317.5;

beforeEach(() => {
  pinClock();
  installAlfredKeys();
  env.AWS_REGION = "us-east-1";
  env.AWS_S3_BUCKET = "synthetic-private-bucket";
  sdk.sign.mockReset();
  sdk.sign.mockResolvedValue("https://example.invalid/signed");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  removeAlfredKeys();
  env.AWS_REGION = undefined;
  env.AWS_S3_BUCKET = undefined;
});

async function world() {
  const w = await partnerWorld();
  await Service.updateOne({ _id: w.service("dexa-scan") }, { $set: { fulfilment: "clinical" } });
  const booked = await w.book("dexa-scan", "09:00");
  expect(booked.status).toBe(201);
  const bookingRef = String(booked.body.data.bookingRef);
  const upload = () =>
    UploadRecord.create({
      organizationId: "org-test",
      uploadedBy: w.director.staff._id,
      purpose: "clinical_document",
      key: `k-${Math.random()}`,
      contentType: "application/pdf",
      sizeBytes: 10,
      verifiedAt: new Date(),
    });
  const panel = async (extra: Record<string, unknown> = {}) =>
    LabPanel.create({
      organizationId: "org-test",
      memberId: w.aMember._id,
      drawnAt: new Date("2027-03-01T10:00:00Z"),
      results: [
        {
          biomarkerId: w.aMember._id,
          key: "k",
          name: "n",
          category: "c",
          resultType: "numeric",
          value: SENTINEL,
        },
      ],
      appointmentId: bookingRef,
      documentUploadId: (await upload())._id,
      ...extra,
    });
  const staff = client(app, w.director.accessToken);
  const reviewPath = (id: unknown) => `/members/${idOf(w.aMember)}/lab-panels/${String(id)}`;
  return { ...w, bookingRef, panel, upload, staff, reviewPath };
}
const reviewed = { reviewStatus: "reviewed", reviewedAt: new Date("2027-03-02T09:00:00Z") };

describe("GET /clinical/reports/{reportRef}", () => {
  it("is a 200 pending with a null URL until reviewed, linked and a PDF is attached", async () => {
    const w = await world();
    const row = await w.panel();
    const res = await w.alfred.get(`/clinical/reports/lab_${row._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      reportRef: `lab_${row._id}`,
      bookingRef: w.bookingRef,
      status: "pending",
      format: "pdf",
      contentUrl: null,
      contentExpiresAt: null,
      summary: { title: expect.any(String) },
    });
    expect(JSON.stringify(res.body)).not.toContain(String(SENTINEL));
    expect(sdk.sign).not.toHaveBeenCalled();
    const noPdf = await w.panel({ ...reviewed, documentUploadId: undefined });
    const second = await w.alfred.get(`/clinical/reports/lab_${noPdf._id}`);
    expect(second.body.data.status).toBe("pending");
  });
  it("is ready once reviewed with a PDF, with a 600 second URL and no values", async () => {
    const w = await world();
    const row = await w.panel(reviewed);
    const res = await w.alfred.get(`/clinical/reports/lab_${row._id}`);
    expect(res.body.data.status).toBe("ready");
    expect(res.body.data.contentUrl).toBe("https://example.invalid/signed");
    expect(Date.parse(res.body.data.contentExpiresAt) - Date.now()).toBe(600_000);
    expect(sdk.sign.mock.calls[0]?.[2]).toEqual({ expiresIn: 600 });
    expect(res.body.data.summary.resultedAt).toBe("2027-03-02T09:00:00.000Z");
    expect(JSON.stringify(res.body)).not.toContain(String(SENTINEL));
  });
  it("serves a scan under a scan_ ref", async () => {
    const w = await world();
    const scan = await Scan.create({
      organizationId: "org-test",
      memberId: w.aMember._id,
      performedAt: new Date("2027-03-01T10:00:00Z"),
      appointmentId: w.bookingRef,
      documentUploadId: (await w.upload())._id,
      ...reviewed,
    });
    const res = await w.alfred.get(`/clinical/reports/scan_${scan._id}`);
    expect(res.body.data).toMatchObject({ reportRef: `scan_${scan._id}`, status: "ready" });
  });
  it("answers 404 for another member's report, an unlinked one, an unknown or malformed ref", async () => {
    const w = await world();
    const other = await w.member([], {
      alfredAccountId: "6710bb4e2f9c1a0031d5e7b7",
      status: "active",
    });
    const theirs = await LabPanel.create({
      organizationId: "org-test",
      memberId: other._id,
      drawnAt: new Date(),
      appointmentId: w.bookingRef,
      documentUploadId: (await w.upload())._id,
      ...reviewed,
    });
    const unlinked = await w.panel({ appointmentId: null });
    for (const ref of [
      `lab_${theirs._id}`,
      `lab_${unlinked._id}`,
      `scan_${unlinked._id}`,
      `lab_${"0".repeat(24)}`,
      "lab_nope",
      "report-1",
    ])
      expect((await w.alfred.get(`/clinical/reports/${ref}`)).status).toBe(404);
    const strangerClient = alfredClient(app, () =>
      alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7c1" })
    );
    expect((await strangerClient.get(`/clinical/reports/lab_${unlinked._id}`)).status).toBe(404);
  });
  it("answers 410 once withdrawn, on both endpoints", async () => {
    const w = await world();
    const row = await w.panel({ ...reviewed, withdrawnAt: new Date() });
    expect((await w.alfred.get(`/clinical/reports/lab_${row._id}`)).status).toBe(410);
    expect((await w.alfred.post(`/clinical/reports/lab_${row._id}/export`)).status).toBe(410);
  });
});

describe("POST /clinical/reports/{reportRef}/export", () => {
  it("mints a fresh URL on every call, even under a repeated Idempotency-Key", async () => {
    const w = await world();
    const row = await w.panel(reviewed);
    const first = await w.alfred.post(`/clinical/reports/lab_${row._id}/export`, {}, "same-key");
    const again = await w.alfred.post(`/clinical/reports/lab_${row._id}/export`, {}, "same-key");
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(first.body.data).toMatchObject({
      format: "pdf",
      contentUrl: "https://example.invalid/signed",
    });
    expect(sdk.sign).toHaveBeenCalledTimes(2);
  });
  it("is 409 REPORT_NOT_READY while pending and 404 for an unknown ref", async () => {
    const w = await world();
    const row = await w.panel();
    const res = await w.alfred.post(`/clinical/reports/lab_${row._id}/export`);
    expect([res.status, res.body.data?.code ?? res.body.code]).toEqual([409, "REPORT_NOT_READY"]);
    expect((await w.alfred.post(`/clinical/reports/lab_${"0".repeat(24)}/export`)).status).toBe(
      404
    );
  });
});

describe("clinical.report_ready event", () => {
  const events = () => PartnerOutbox.find({ type: "clinical.report_ready" }).lean();
  it("is written with the review, names the booking, and carries no values", async () => {
    const w = await world();
    const row = await w.panel();
    const res = await w.staff.send("post", `${w.reviewPath(row._id)}/review`, {});
    expect(res.status).toBe(200);
    const [event, ...rest] = await events();
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      accountId: ACCOUNT,
      resource: { kind: "report", ref: `lab_${row._id}` },
      payload: {
        reportRef: `lab_${row._id}`,
        bookingRef: w.bookingRef,
        status: "ready",
        format: "pdf",
        summary: { title: expect.any(String) },
      },
    });
    expect(JSON.stringify(event)).not.toContain(String(SENTINEL));
    // A repeat review is refused and writes nothing more.
    expect((await w.staff.send("post", `${w.reviewPath(row._id)}/review`, {})).status).toBe(409);
    expect(await events()).toHaveLength(1);
    // The visit is touched so the orders stream carries the new status.
    const visit = await Appointment.findById(w.bookingRef).lean();
    expect(visit?.updatedAt.getTime()).toBe(Date.now());
  });
  it("waits for a visit link and a PDF, then fires when the link completes the report", async () => {
    const w = await world();
    const unlinked = await w.panel({ appointmentId: null });
    expect((await w.staff.send("post", `${w.reviewPath(unlinked._id)}/review`, {})).status).toBe(
      200
    );
    const noPdf = await w.panel({ documentUploadId: undefined });
    await w.staff.send("post", `${w.reviewPath(noPdf._id)}/review`, {});
    expect(await events()).toHaveLength(0);
    const link = await w.staff.send("put", `${w.reviewPath(unlinked._id)}/visit`, {
      appointmentId: w.bookingRef,
    });
    expect(link.status).toBe(200);
    expect((await events()).map((e) => e.resource.ref)).toEqual([`lab_${unlinked._id}`]);
    // Linking the same visit again is a no-op; a ready report cannot move.
    await w.staff.send("put", `${w.reviewPath(unlinked._id)}/visit`, {
      appointmentId: w.bookingRef,
    });
    expect(await events()).toHaveLength(1);
    const second = await w.book("vo2-max-test", "11:00");
    const move = await w.staff.send("put", `${w.reviewPath(unlinked._id)}/visit`, {
      appointmentId: second.body.data.bookingRef,
    });
    expect([move.status, move.body.code]).toEqual([409, "REPORT_READY"]);
  });
  it("refuses a visit that is not this member's, on create and on link", async () => {
    const w = await world();
    const other = await w.member([], {
      alfredAccountId: "6710bb4e2f9c1a0031d5e7b7",
      status: "active",
    });
    const theirs = await LabPanel.create({
      organizationId: "org-test",
      memberId: other._id,
      drawnAt: new Date(),
    });
    const link = await w.staff.send(
      "put",
      `/members/${idOf(other)}/lab-panels/${theirs._id}/visit`,
      {
        appointmentId: w.bookingRef,
      }
    );
    expect(link.status).toBe(404);
    const ids = await catalogIds();
    const created = await w.staff.send("post", `/members/${idOf(other)}/lab-panels`, {
      drawnAt: "2027-03-01T10:00:00Z",
      results: [result(ids["tsh"], 3.1)],
      appointmentId: w.bookingRef,
    });
    expect(created.status).toBe(404);
    const scan = await w.staff.send("post", `/members/${idOf(other)}/scans`, {
      performedAt: "2027-03-01T10:00:00Z",
      appointmentId: w.bookingRef,
    });
    expect(scan.status).toBe(404);
    expect(await LabPanel.countDocuments({ memberId: other._id })).toBe(1);
    expect((await LabPanel.findById(theirs._id).lean())?.appointmentId).toBeNull();
  });
});

describe("GET /orders for clinical services", () => {
  it("emits kind clinical with the clinical vocabulary and filters by kind", async () => {
    const w = await world();
    const orgPull = alfredClient(app, () => alfredToken({ accountId: null }));
    const only = async (kind?: string) =>
      (await orgPull.get(`/orders${kind ? `?kind=${kind}` : ""}`)).body.data.items as {
        kind: string;
        status: string;
      }[];
    expect(await only()).toMatchObject([{ kind: "clinical", status: "booked" }]);
    await w.alfred.post(`/bookings/${w.bookingRef}/check-in`, {});
    // Check-in needs the visit window; fall back to the stored status when it is refused.
    await Appointment.updateOne({ _id: w.bookingRef }, { $set: { status: "checked_in" } });
    expect(await only("clinical")).toMatchObject([{ kind: "clinical", status: "sample_taken" }]);
    expect(await only("booking")).toEqual([]);
    await w.panel(reviewed);
    expect(await only("clinical")).toMatchObject([{ kind: "clinical", status: "report_ready" }]);
    await Appointment.updateOne({ _id: w.bookingRef }, { $set: { status: "cancelled" } });
    expect(await only()).toMatchObject([{ status: "cancelled" }]);
    await Service.updateOne({ slug: "dexa-scan" }, { $set: { fulfilment: "standard" } });
    expect(await only("booking")).toMatchObject([{ kind: "booking" }]);
  });
});

describe("Service.fulfilment", () => {
  const catalog = async (slug: string) =>
    (await alfredClient(app, () => alfredToken({ accountId: null })).get(`/catalog/${slug}`)).body
      .data;
  it("defaults to standard, is toggled by a service PATCH, and the catalog item follows it", async () => {
    const w = await world();
    await Service.updateOne({ _id: w.service("dexa-scan") }, { $set: { fulfilment: "standard" } });
    expect((await catalog("dexa-scan")).fulfilment).toBe("standard");
    const before = (await catalog("dexa-scan")).version;
    const row = await Service.findById(w.service("dexa-scan")).lean();
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const res = await w.api.patch(`/api/v1/services/${w.service("dexa-scan")}`, {
      fulfilment: "clinical",
      expectedVersion: (row as { version?: number } | null)?.version ?? 0,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.fulfilment).toBe("clinical");
    const after = await catalog("dexa-scan");
    expect(after.fulfilment).toBe("clinical");
    expect(after.version).toBeGreaterThan(before);
    const bad = await w.api.patch(`/api/v1/services/${w.service("dexa-scan")}`, {
      fulfilment: "lab",
      expectedVersion: ((row as { version?: number } | null)?.version ?? 0) + 1,
    });
    expect(bad.status).toBe(400);
    expect((await catalog("vo2-max-test")).fulfilment).toBe("standard");
  });
});

describe("appointmentId on create", () => {
  it("is stored for the member's own visit on a panel and a scan", async () => {
    const w = await world();
    const ids = await catalogIds();
    const panel = await w.staff.send("post", `/members/${idOf(w.aMember)}/lab-panels`, {
      drawnAt: "2027-03-01T10:00:00Z",
      results: [result(ids["tsh"], 3.1)],
      appointmentId: w.bookingRef,
    });
    expect([panel.status, String(panel.body.data.appointmentId)]).toEqual([201, w.bookingRef]);
    const scan = await w.staff.send("post", `/members/${idOf(w.aMember)}/scans`, {
      performedAt: "2027-03-01T10:00:00Z",
      appointmentId: w.bookingRef,
    });
    expect([scan.status, String(scan.body.data.appointmentId)]).toEqual([201, w.bookingRef]);
  });
});
