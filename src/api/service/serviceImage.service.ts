import { randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError, BadRequestError } from "../../common/errors/AppError.js";
import { env } from "../../config/env.js";
import { ServiceImageUpload } from "./service.model.js";
function storage() {
  if (!(env.AWS_REGION && env.AWS_S3_BUCKET))
    throw new AppError(
      "Image uploads are not configured",
      503,
      true,
      undefined,
      "STORAGE_NOT_CONFIGURED"
    );
  return { client: new S3Client({ region: env.AWS_REGION }), bucket: env.AWS_S3_BUCKET };
}
export async function presignServiceImage(
  organizationId: string,
  actorId: string,
  input: { contentType: string; size: number }
) {
  const { client, bucket } = storage();
  const key = `${organizationId}/service-images/${randomUUID()}`;
  const url = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: input.contentType,
      ContentLength: input.size,
      ServerSideEncryption: "AES256",
    }),
    { expiresIn: 300 }
  );
  const upload = await ServiceImageUpload.create({
    organizationId,
    actorId,
    key,
    ...input,
    expiresAt: new Date(Date.now() + 600_000),
  });
  return {
    uploadId: String(upload._id),
    url,
    expiresIn: 300,
    headers: { "Content-Type": input.contentType, "x-amz-server-side-encryption": "AES256" },
  };
}
export async function attachServiceImage(
  organizationId: string,
  actorId: string,
  uploadId: string
): Promise<string> {
  const upload = await ServiceImageUpload.findOne({
    _id: uploadId,
    organizationId,
    actorId,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!upload) throw new BadRequestError("Image upload expired or unavailable");
  const { client, bucket } = storage();
  let head: HeadObjectCommandOutput;
  try {
    head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: upload.key }), {
      abortSignal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new BadRequestError("Upload the image before saving");
  }
  if (
    head.ContentLength !== upload.size ||
    head.ContentType !== upload.contentType ||
    !["AES256", "aws:kms"].includes(head.ServerSideEncryption ?? "")
  )
    throw new BadRequestError("Image does not match the signed upload");
  const claimed = await ServiceImageUpload.updateOne(
    { _id: upload._id, consumedAt: null },
    { $set: { consumedAt: new Date() } }
  );
  if (claimed.modifiedCount !== 1) throw new BadRequestError("Image upload already used");
  return upload.key;
}
export function serviceImageUrl(key?: string): Promise<string | undefined> {
  if (!key) return Promise.resolve(undefined);
  const { client, bucket } = storage();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 300,
  });
}
