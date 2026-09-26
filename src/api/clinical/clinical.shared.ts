import type { Request } from "express";
import mongoose, { type ClientSession } from "mongoose";
import { ConflictError, NotFoundError } from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { audit } from "../audit/audit.js";
import type { MemberDocument } from "../member/member.model.js";
import { memberTarget } from "../member/member.scope.js";
import type { PermissionModule } from "../role/permission.types.js";
import { StaffMember } from "../staff/staff.model.js";
import { UploadRecord } from "../upload/upload.model.js";
import { signedDownload, verifiedUpload } from "../upload/upload.service.js";

export type ClinicalModule = Extract<
  PermissionModule,
  "LABS_SCANS" | "PROTOCOLS" | "CLINICAL_NOTES"
>;
/** The member in :id, scoped by MEMBER_RECORDS and the clinical module's own scope. */
export const clinicalMember = (req: Request, module: ClinicalModule, write = false) =>
  memberTarget(req, { modules: [module], write });
export const byMember = (member: MemberDocument) => ({
  organizationId: member.organizationId,
  memberId: member._id,
});
export const memberIdOf = (member: MemberDocument) => String(member._id);

/** PHI read: one audit row naming the member, written before the data leaves. */
export const auditRead = (
  req: Request,
  targetType: string,
  member: MemberDocument,
  targetId?: string
) => audit(req, "viewed", targetType, targetId ?? memberIdOf(member), memberIdOf(member));

/** A write and its audit row commit together or not at all. */
export function auditedWrite<T>(
  req: Request,
  member: MemberDocument,
  describe: { action: string; targetType: string },
  work: (session: ClientSession) => Promise<T & { _id: unknown }>
) {
  return mongoose.connection.transaction(async (session) => {
    const row = await work(session);
    await audit(
      req,
      describe.action,
      describe.targetType,
      String(row._id),
      memberIdOf(member),
      session
    );
    return row;
  });
}

/**
 * Verify a clinical document upload (actor's own, uploaded, SSE) BEFORE the
 * transaction, then claim it inside the transaction so one file can never be
 * attached to two records or two members.
 */
export async function verifyDocument(req: Request, uploadId?: string) {
  return uploadId ? verifiedUpload(req, "clinical_document", uploadId) : null;
}
export async function claimDocument(uploadId: unknown, attachedTo: string, session: ClientSession) {
  const claimed = await UploadRecord.findOneAndUpdate(
    { _id: uploadId, attachedTo: null },
    { $set: { attachedTo } },
    { session, new: true }
  );
  if (!claimed)
    throw new ConflictError("This file is already attached", undefined, "UPLOAD_ALREADY_ATTACHED");
}
export async function documentLink(
  req: Request,
  member: MemberDocument,
  record: { _id: unknown; documentUploadId?: unknown } | null,
  targetType: string
) {
  if (!record?.documentUploadId) throw new NotFoundError("No document attached");
  await audit(req, "downloaded", targetType, String(record._id), memberIdOf(member));
  return signedDownload(String(record.documentUploadId), member.organizationId);
}

export async function staffNames(ids: unknown[]) {
  const rows = await StaffMember.find({ _id: { $in: ids.filter(Boolean) } })
    .select("firstName lastName titlePrefix")
    .lean();
  return new Map(
    rows.map((s) => [
      String(s._id),
      [s.titlePrefix, s.firstName, s.lastName].filter(Boolean).join(" "),
    ])
  );
}
export async function assertStaff(organizationId: string, id: unknown) {
  if (!(await StaffMember.exists({ _id: id, organizationId })))
    throw new NotFoundError("Staff member not found");
}
export const actorId = (req: Request) => actor(req)._id;
