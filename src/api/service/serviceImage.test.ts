import { beforeEach, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { ServiceImageUpload } from "./service.model.js";
import {
  attachServiceImage,
  presignServiceImage,
  serviceImageUrl,
} from "./serviceImage.service.js";
const mocks = vi.hoisted(() => ({ send: vi.fn(), sign: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const original = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...original,
    S3Client: class {
      send = mocks.send;
    },
  };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mocks.sign }));
beforeEach(() => {
  env.AWS_REGION = "us-east-1";
  env.AWS_S3_BUCKET = "private-test-bucket";
  mocks.send.mockReset();
  mocks.sign.mockReset();
  mocks.sign.mockResolvedValue("https://s3.example.invalid/private-signed-url");
});
it("signs five-minute encrypted uploads and downloads without invoking live AWS", async () => {
  const upload = await presignServiceImage("org-test", "actor", {
    contentType: "image/png",
    size: 100,
  });
  expect(upload).toMatchObject({
    expiresIn: 300,
    headers: { "Content-Type": "image/png", "x-amz-server-side-encryption": "AES256" },
  });
  const command = mocks.sign.mock.calls[0]?.[1];
  expect(command.input).toMatchObject({
    Bucket: "private-test-bucket",
    ContentLength: 100,
    ContentType: "image/png",
    ServerSideEncryption: "AES256",
  });
  expect(mocks.sign.mock.calls[0]?.[2]).toEqual({ expiresIn: 300 });
  const record = await ServiceImageUpload.findById(upload.uploadId);
  expect(record?.key).toMatch(/^org-test\/service-images\//);
  expect(record?.actorId).toBe("actor");
  expect(await serviceImageUrl(undefined)).toBeUndefined();
  expect(await serviceImageUrl(record?.key)).toContain("private-signed-url");
  expect(mocks.send).not.toHaveBeenCalled();
});
it("requires storage configuration without falling back to public URLs", async () => {
  env.AWS_S3_BUCKET = undefined;
  await expect(
    presignServiceImage("org", "actor", { contentType: "image/png", size: 10 })
  ).rejects.toMatchObject({ statusCode: 503, code: "STORAGE_NOT_CONFIGURED" });
});
it("rejects wrong organization/actor, missing object, wrong metadata and expired upload", async () => {
  const { uploadId } = await presignServiceImage("org-test", "actor", {
    contentType: "image/png",
    size: 100,
  });
  await expect(attachServiceImage("foreign", "actor", uploadId)).rejects.toMatchObject({
    statusCode: 400,
  });
  await expect(attachServiceImage("org-test", "foreign", uploadId)).rejects.toMatchObject({
    statusCode: 400,
  });
  mocks.send.mockRejectedValueOnce(new Error("Missing object"));
  await expect(attachServiceImage("org-test", "actor", uploadId)).rejects.toMatchObject({
    statusCode: 400,
  });
  for (const metadata of [
    { ContentLength: 99, ContentType: "image/png", ServerSideEncryption: "AES256" },
    { ContentLength: 100, ContentType: "image/jpeg", ServerSideEncryption: "AES256" },
    { ContentLength: 100, ContentType: "image/png" },
  ]) {
    mocks.send.mockResolvedValueOnce(metadata);
    await expect(attachServiceImage("org-test", "actor", uploadId)).rejects.toMatchObject({
      statusCode: 400,
    });
  }
  await ServiceImageUpload.updateOne({ _id: uploadId }, { $set: { expiresAt: new Date(1) } });
  await expect(attachServiceImage("org-test", "actor", uploadId)).rejects.toMatchObject({
    statusCode: 400,
  });
});
it("verifies encrypted image metadata and consumes an actor-bound upload exactly once", async () => {
  const { uploadId } = await presignServiceImage("org-test", "actor", {
    contentType: "image/webp",
    size: 44,
  });
  mocks.send.mockResolvedValue({
    ContentLength: 44,
    ContentType: "image/webp",
    ServerSideEncryption: "AES256",
  });
  const key = await attachServiceImage("org-test", "actor", uploadId);
  expect(key).toMatch(/^org-test\/service-images\//);
  expect((await ServiceImageUpload.findById(uploadId))?.consumedAt).toBeTruthy();
  await expect(attachServiceImage("org-test", "actor", uploadId)).rejects.toMatchObject({
    statusCode: 400,
  });
});
