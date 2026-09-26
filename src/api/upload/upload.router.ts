import { Router } from "express";
import { z } from "zod";
import { ForbiddenError, NotFoundError } from "../../common/errors/AppError.js";
import { actor, idParams, objectId, secured } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import { permits, resolvePermissions } from "../role/permission.js";
import { StaffDocument } from "../staff/staff-details.model.js";
import { staffTarget } from "../staff/staff.service.js";
import {
  attachDocument,
  attachLogo,
  attachPhoto,
  downloadDocument,
  presign,
  signedDownload,
} from "./upload.service.js";
export const uploadRouter = Router();
const input = z
  .object({
    purpose: z.enum(["staff_document", "staff_photo", "organization_logo", "member_photo"]),
    contentType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
    sizeBytes: z
      .number()
      .int()
      .min(1)
      .max(10 * 1024 * 1024),
  })
  .strict()
  .refine(
    (v) => v.purpose === "staff_document" || v.contentType !== "application/pdf",
    "Images must use JPEG or PNG"
  );
secured(uploadRouter, "post", "/uploads/presign", null, { body: input }, async (req) => {
  const permissions = await resolvePermissions(actor(req));
  const modules = {
    organization_logo: "SYSTEM_SETTINGS",
    member_photo: "MEMBER_RECORDS",
  } as const;
  const module = modules[req.body.purpose as keyof typeof modules] ?? "STAFF_RECORDS";
  if (!permits(permissions[module].level, "edit")) throw new ForbiddenError();
  return presign(req);
});
secured(
  uploadRouter,
  "post",
  "/settings/organization/logo",
  { module: "SYSTEM_SETTINGS", level: "edit" },
  { body: z.object({ uploadId: objectId }).strict() },
  attachLogo
);
secured(
  uploadRouter,
  "post",
  "/staff/:id/photo",
  { module: "STAFF_RECORDS", level: "edit" },
  { params: idParams, body: z.object({ uploadId: objectId }).strict() },
  attachPhoto
);
secured(
  uploadRouter,
  "get",
  "/staff/:id/photo",
  { module: "STAFF_RECORDS", level: "view" },
  { params: idParams },
  async (req) => {
    const target = await staffTarget(req);
    if (!target.photoUploadId) throw new NotFoundError();
    return signedDownload(String(target.photoUploadId), target.organizationId);
  }
);
secured(
  uploadRouter,
  "get",
  "/staff/:id/documents",
  { module: "STAFF_RECORDS", level: "view" },
  { params: idParams },
  async (req) => {
    const target = await staffTarget(req);
    await audit(req, "viewed", "StaffDocuments", String(target._id));
    return StaffDocument.find({
      staffId: target._id,
      organizationId: target.organizationId,
    }).lean();
  }
);
secured(
  uploadRouter,
  "post",
  "/staff/:id/documents",
  { module: "STAFF_RECORDS", level: "edit" },
  {
    params: idParams,
    body: z.object({ name: z.string().trim().min(1).max(150), uploadId: objectId }).strict(),
  },
  attachDocument,
  201
);
secured(
  uploadRouter,
  "get",
  "/staff/:id/documents/:docId",
  { module: "STAFF_RECORDS", level: "view" },
  { params: idParams.extend({ docId: objectId }) },
  downloadDocument
);
