import { randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Request } from "express";
import { AppError, NotFoundError, ValidationError } from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { env } from "../../config/env.js";
import { audit } from "../audit/audit.js";
import { OrganizationSettings } from "../settings/settings.model.js";
import { StaffDocument } from "../staff/staff-details.model.js";
import { staffTarget } from "../staff/staff.service.js";
import { UploadRecord } from "./upload.model.js";
function storage() {
  if (!(env.AWS_REGION && env.AWS_S3_BUCKET))
    throw new AppError(
      "File storage is not configured",
      503,
      true,
      undefined,
      "STORAGE_UNAVAILABLE"
    );
  return new S3Client({ region: env.AWS_REGION });
}
export async function presign(req: Request, purpose = req.body.purpose) {
  const client = storage();
  const staff = actor(req);
  const key = `${staff.organizationId}/${purpose}/${randomUUID()}`;
  const headers = {
    "Content-Type": req.body.contentType,
    "x-amz-server-side-encryption": "AES256",
  };
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: key,
      ContentType: req.body.contentType,
      ContentLength: req.body.sizeBytes,
      ServerSideEncryption: "AES256",
    }),
    { expiresIn: 180 }
  );
  const record = await UploadRecord.create({
    organizationId: staff.organizationId,
    uploadedBy: staff._id,
    purpose,
    key,
    contentType: req.body.contentType,
    sizeBytes: req.body.sizeBytes,
  });
  await audit(req, "upload_requested", "UploadRecord", String(record._id));
  return { uploadId: String(record._id), uploadUrl, headers, expiresIn: 180 };
}
export async function verifiedUpload(req: Request, purpose: string, uploadId = req.body.uploadId) {
  const staff = actor(req);
  const row = await UploadRecord.findOne({
    _id: uploadId,
    organizationId: staff.organizationId,
    uploadedBy: staff._id,
    purpose,
  });
  if (!row) throw new NotFoundError();
  const client = storage();
  let metadata: HeadObjectCommandOutput;
  try {
    metadata = await client.send(
      new HeadObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: row.key }),
      { abortSignal: AbortSignal.timeout(10_000) }
    );
  } catch {
    throw new ValidationError("Upload the file before saving it", "UPLOAD_INCOMPLETE");
  }
  if (
    metadata.ContentType !== row.contentType ||
    metadata.ContentLength !== row.sizeBytes ||
    metadata.ServerSideEncryption !== "AES256"
  )
    throw new ValidationError("Uploaded file metadata does not match", "UPLOAD_INVALID");
  row.verifiedAt = new Date();
  await row.save();
  return row;
}
export async function signedDownload(uploadId: string, organizationId: string) {
  const row = await UploadRecord.findOne({
    _id: uploadId,
    organizationId,
    verifiedAt: { $ne: null },
  });
  if (!row) throw new NotFoundError();
  return {
    url: await getSignedUrl(
      storage(),
      new GetObjectCommand({
        Bucket: env.AWS_S3_BUCKET,
        Key: row.key,
        ResponseContentDisposition: "attachment",
      }),
      { expiresIn: 300 }
    ),
    expiresIn: 300,
  };
}
export async function attachDocument(req: Request) {
  const target = await staffTarget(req);
  const upload = await verifiedUpload(req, "staff_document");
  const document = await StaffDocument.create({
    organizationId: target.organizationId,
    staffId: target._id,
    uploadId: upload._id,
    name: req.body.name,
    createdBy: actor(req)._id,
  });
  await audit(req, "created", "StaffDocument", String(document._id));
  return document;
}
export async function downloadDocument(req: Request) {
  const target = await staffTarget(req);
  const row = await StaffDocument.findOne({
    _id: req.params["docId"],
    staffId: target._id,
    organizationId: target.organizationId,
  });
  if (!row) throw new NotFoundError();
  await audit(req, "viewed", "StaffDocument", String(row._id));
  return signedDownload(String(row.uploadId), target.organizationId);
}
export async function attachLogo(req: Request) {
  const row = await verifiedUpload(req, "organization_logo");
  await OrganizationSettings.updateOne(
    { organizationId: actor(req).organizationId },
    { $set: { logoUploadId: row._id } },
    { upsert: true }
  );
  await audit(req, "updated", "OrganizationLogo", String(row._id));
  return { uploadId: String(row._id) };
}
export async function attachPhoto(req: Request) {
  const target = await staffTarget(req);
  const row = await verifiedUpload(req, "staff_photo");
  target.set("photoUploadId", row._id);
  await target.save();
  await audit(req, "updated", "StaffPhoto", String(target._id));
  return { uploadId: String(row._id) };
}
