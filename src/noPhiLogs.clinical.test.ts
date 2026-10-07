import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PartnerOutbox } from "./api/alfred-partner/outbox/partnerOutbox.model.js";
import { drainOutbox } from "./api/alfred-partner/outbox/partnerOutbox.publisher.js";
import { LabPanel } from "./api/clinical/records.model.js";
import { Service } from "./api/service/service.model.js";
import { UploadRecord } from "./api/upload/upload.model.js";
import { env } from "./config/env.js";
import { pinClock } from "./test/appointmentFixture.js";
import { client, idOf } from "./test/memberFixture.js";
import {
  ACCOUNT,
  alfredClient,
  installAlfredKeys,
  removeAlfredKeys,
} from "./test/partnerFixture.js";
import { partnerWorld } from "./test/partnerWorld.js";
import { app } from "./test/scheduleFixture.js";

/**
 * Clinical report flow (review with event, report view, export, a failing publish) with sentinel
 * values: no log line, response, event or outbox error text may carry a result value or a report URL.
 */
const sink = vi.hoisted(() => ({ lines: [] as string[] }));
const sdk = vi.hoisted(() => ({ send: vi.fn(), sign: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = sdk.send;
  },
  PutObjectCommand: class {},
  GetObjectCommand: class {},
  HeadObjectCommand: class {},
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: sdk.sign }));
vi.mock("./common/utils/logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./common/utils/logger.js")>();
  const capture = {
    write: (line: string) => {
      sink.lines.push(line);
    },
  };
  return { ...real, logger: real.createLogger(capture as never) };
});
vi.mock("./common/middleware/requestLogger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./common/middleware/requestLogger.js")>();
  const { logger } = await import("./common/utils/logger.js");
  return { ...real, requestLogger: real.createRequestLogger(logger, true) };
});

const VALUE = 86421.75;
const URL_SENTINEL = "REPORT-URL-SENTINEL";
beforeEach(() => {
  pinClock();
  sink.lines.length = 0;
  installAlfredKeys();
  env.AWS_REGION = "us-east-1";
  env.AWS_S3_BUCKET = "synthetic-private-bucket";
  sdk.sign.mockResolvedValue(`https://example.invalid/${URL_SENTINEL}`);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  removeAlfredKeys();
  env.AWS_REGION = undefined;
  env.AWS_S3_BUCKET = undefined;
});

it("clinical report flows log no result value, report URL or outbox error text", async () => {
  const w = await partnerWorld();
  await Service.updateOne({ _id: w.service("dexa-scan") }, { $set: { fulfilment: "clinical" } });
  const booked = await w.book("dexa-scan", "09:00");
  const upload = await UploadRecord.create({
    organizationId: "org-test",
    uploadedBy: w.director.staff._id,
    purpose: "clinical_document",
    key: "k-phi",
    contentType: "application/pdf",
    sizeBytes: 10,
    verifiedAt: new Date(),
  });
  const panel = await LabPanel.create({
    organizationId: "org-test",
    memberId: w.aMember._id,
    drawnAt: new Date(),
    results: [
      {
        biomarkerId: w.aMember._id,
        key: "k",
        name: "n",
        category: "c",
        resultType: "numeric",
        value: VALUE,
      },
    ],
    appointmentId: booked.body.data.bookingRef,
    documentUploadId: upload._id,
  });
  const staff = client(app, w.director.accessToken);
  const review = await staff.send(
    "post",
    `/members/${idOf(w.aMember)}/lab-panels/${panel._id}/review`,
    {}
  );
  expect(review.status).toBe(200);
  const alfred = alfredClient(app);
  const view = await alfred.get(`/clinical/reports/lab_${panel._id}`);
  const exported = await alfred.post(`/clinical/reports/lab_${panel._id}/export`);
  expect([view.status, exported.status]).toEqual([200, 200]);
  expect((await alfred.get(`/clinical/reports/lab_${"0".repeat(24)}`)).status).toBe(404);
  // The queued event, then a publish that fails with an error echoing the value.
  const event = await PartnerOutbox.findOne({ type: "clinical.report_ready" }).lean();
  expect(JSON.stringify(event)).not.toContain(String(VALUE));
  expect(JSON.stringify(event)).not.toContain(URL_SENTINEL);
  vi.stubGlobal("fetch", async () => {
    throw new Error(`connect failed ${VALUE} ${URL_SENTINEL}`);
  });
  expect((await drainOutbox()).retried).toBeGreaterThan(0);
  const outbox = JSON.stringify(await PartnerOutbox.find({}).lean());
  expect(outbox).not.toContain(String(VALUE));
  expect(outbox).not.toContain(URL_SENTINEL);
  expect(ACCOUNT).toBeTruthy();
  expect(sink.lines.length).toBeGreaterThan(5);
  const text = sink.lines
    .join("\n")
    .replace(/"time":"[^"]*"/g, '""')
    .replace(/[a-f\d]{24}/gi, "");
  expect([String(VALUE), URL_SENTINEL].filter((s) => text.includes(s))).toEqual([]);
});
