import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { createServer } from "../../server.js";
import { staffFixture } from "../../test/staffFixture.js";
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
beforeEach(() => {
  app = createServer();
  env.AWS_REGION = "us-east-1";
  env.AWS_S3_BUCKET = "synthetic-private-bucket";
  sdk.send.mockReset();
  sdk.send.mockResolvedValue({
    ContentType: "application/pdf",
    ContentLength: 123,
    ServerSideEncryption: "AES256",
  });
  sdk.sign.mockReset();
  sdk.sign.mockResolvedValue("https://example.invalid/signed");
});
afterEach(() => {
  env.AWS_REGION = undefined;
  env.AWS_S3_BUCKET = undefined;
});
it("signs bound uploads and verifies private document metadata before attachment", async () => {
  const master = await staffFixture();
  const id = String(master.staff._id);
  const auth = { type: "bearer" as const };
  const upload = await request(app)
    .post("/api/v1/uploads/presign")
    .auth(master.accessToken, auth)
    .send({ purpose: "staff_document", contentType: "application/pdf", sizeBytes: 123 });
  expect(upload.status).toBe(200);
  expect(upload.body.data.expiresIn).toBe(180);
  const doc = await request(app)
    .post(`/api/v1/staff/${id}/documents`)
    .auth(master.accessToken, auth)
    .send({ uploadId: upload.body.data.uploadId, name: "Synthetic document" });
  expect(doc.status).toBe(201);
  expect(
    (await request(app).get(`/api/v1/staff/${id}/documents`).auth(master.accessToken, auth)).body
      .data
  ).toHaveLength(1);
  const download = await request(app)
    .get(`/api/v1/staff/${id}/documents/${doc.body.data._id}`)
    .auth(master.accessToken, auth);
  expect(download.status).toBe(200);
  expect(download.body.data.expiresIn).toBe(300);
  const another = await staffFixture();
  expect(
    (
      await request(app)
        .post(`/api/v1/staff/${id}/documents`)
        .auth(another.accessToken, auth)
        .send({ uploadId: upload.body.data.uploadId, name: "Wrong actor" })
    ).status
  ).toBe(404);
});
it("rejects unconfigured storage, wrong file types and mismatched uploaded metadata", async () => {
  const master = await staffFixture();
  const viewer = await staffFixture(false);
  const auth = { type: "bearer" as const };
  expect(
    (
      await request(app)
        .post("/api/v1/uploads/presign")
        .auth(viewer.accessToken, auth)
        .send({ purpose: "staff_document", contentType: "application/pdf", sizeBytes: 123 })
    ).status
  ).toBe(403);
  expect(
    (
      await request(app)
        .post("/api/v1/uploads/presign")
        .auth(master.accessToken, auth)
        .send({ purpose: "staff_photo", contentType: "application/pdf", sizeBytes: 123 })
    ).status
  ).toBe(400);
  const upload = (
    await request(app)
      .post("/api/v1/uploads/presign")
      .auth(master.accessToken, auth)
      .send({ purpose: "staff_document", contentType: "application/pdf", sizeBytes: 123 })
  ).body.data;
  sdk.send.mockResolvedValueOnce({ ContentType: "text/html", ContentLength: 123 });
  expect(
    (
      await request(app)
        .post(`/api/v1/staff/${master.staff._id}/documents`)
        .auth(master.accessToken, auth)
        .send({ uploadId: upload.uploadId, name: "Invalid" })
    ).status
  ).toBe(422);
  env.AWS_S3_BUCKET = undefined;
  expect(
    (
      await request(app)
        .post("/api/v1/uploads/presign")
        .auth(master.accessToken, auth)
        .send({ purpose: "staff_document", contentType: "application/pdf", sizeBytes: 123 })
    ).status
  ).toBe(503);
});
it("attaches a logo and staff photo only after verification", async () => {
  const master = await staffFixture();
  const auth = { type: "bearer" as const };
  sdk.send.mockResolvedValue({
    ContentType: "image/png",
    ContentLength: 123,
    ServerSideEncryption: "AES256",
  });
  for (const [purpose, path] of [
    ["organization_logo", "/settings/organization/logo"],
    ["staff_photo", `/staff/${master.staff._id}/photo`],
  ]) {
    const upload = (
      await request(app)
        .post("/api/v1/uploads/presign")
        .auth(master.accessToken, auth)
        .send({ purpose, contentType: "image/png", sizeBytes: 123 })
    ).body.data;
    expect(
      (
        await request(app)
          .post(`/api/v1${path}`)
          .auth(master.accessToken, auth)
          .send({ uploadId: upload.uploadId })
      ).status
    ).toBe(200);
  }
  expect(
    (
      await request(app)
        .get(`/api/v1/staff/${master.staff._id}/photo`)
        .auth(master.accessToken, auth)
    ).status
  ).toBe(200);
});

it("returns signed profile images in organization and session views", async () => {
  const master = await staffFixture();
  const auth = { type: "bearer" as const };
  sdk.send.mockResolvedValue({
    ContentType: "image/png",
    ContentLength: 123,
    ServerSideEncryption: "AES256",
  });
  for (const [purpose, path] of [
    ["organization_logo", "/settings/organization/logo"],
    ["staff_photo", `/staff/${master.staff._id}/photo`],
  ]) {
    const upload = await request(app)
      .post("/api/v1/uploads/presign")
      .auth(master.accessToken, auth)
      .send({ purpose, contentType: "image/png", sizeBytes: 123 });
    await request(app)
      .post(`/api/v1${path}`)
      .auth(master.accessToken, auth)
      .send({ uploadId: upload.body.data.uploadId })
      .expect(200);
  }
  const settings = await request(app)
    .get("/api/v1/settings/organization")
    .auth(master.accessToken, auth)
    .expect(200);
  expect(settings.body.data.logoUrl).toBe("https://example.invalid/signed");
  const me = await request(app).get("/api/v1/me").auth(master.accessToken, auth).expect(200);
  expect(me.body.data.avatarUrl).toBe("https://example.invalid/signed");
  expect(me.body.data.organization.logoUrl).toBe("https://example.invalid/signed");
});
