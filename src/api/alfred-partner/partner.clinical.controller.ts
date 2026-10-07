import type { Request, Response } from "express";
import { AppError, NotFoundError } from "../../common/errors/AppError.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { audit } from "../audit/audit.js";
import { signedDownload } from "../upload/upload.service.js";
import {
  REPORT_MODELS,
  type ReportFacts,
  type ReportKind,
  parseReportRef,
  reportIsReady,
  reportRefOf,
  visitTitle,
} from "./clinicalReport.js";
import { contractConflict } from "./partner.errors.js";

/** Contract §5.11: the content URL lives 300 to 900 seconds. */
export const REPORT_URL_SECONDS = 600;

// Never load the stored results: the report routes return a title and dates only.
const FIELDS =
  "memberId appointmentId documentUploadId reviewStatus reviewedAt withdrawnAt drawnAt performedAt";

type Row = ReportFacts & { memberId: unknown; drawnAt?: Date; performedAt?: Date };

/** The member's own report, or 404 (unknown ref, someone else's, or not tied to a visit); 410 once withdrawn. */
async function ownedReport(req: Request): Promise<{ kind: ReportKind; row: Row }> {
  const member = req.partnerMember;
  const parsed = parseReportRef(String(req.params["reportRef"]));
  const asked = (req.query as { accountId?: string }).accountId;
  // §5.11: a report that does not belong to that accountId is a 404.
  if (!(member && parsed) || (asked && asked !== req.partner?.accountId))
    throw new NotFoundError("Report not found");
  const row = (await REPORT_MODELS[parsed.kind]
    .findOne({ _id: parsed.id, organizationId: member.organizationId, memberId: member._id })
    .select(FIELDS)
    .lean()) as Row | null;
  if (!row?.appointmentId) throw new NotFoundError("Report not found");
  if (row.withdrawnAt) throw new AppError("This report is no longer available", 410);
  return { kind: parsed.kind, row };
}

async function mint(row: Row, organizationId: string) {
  // Computed before signing, so the stated expiry is never later than the URL's real one.
  const contentExpiresAt = new Date(Date.now() + REPORT_URL_SECONDS * 1000);
  const link = await signedDownload(
    String(row.documentUploadId),
    organizationId,
    REPORT_URL_SECONDS
  );
  return { contentUrl: link.url, contentExpiresAt };
}
const send = (res: Response, message: string, data: unknown) =>
  res.json(ServiceResponse.success(message, data));

/** `GET /clinical/reports/{reportRef}` (§5.11). Pending is a 200, never a 409. Dates and a title only, no values. */
export async function getReport(req: Request, res: Response): Promise<void> {
  const { kind, row } = await ownedReport(req);
  const member = req.partnerMember;
  if (!member) throw new NotFoundError("Report not found");
  const ready = reportIsReady(row);
  await audit(req, "viewed", "Report", reportRefOf(kind, row._id), String(member._id));
  send(res, "Report", {
    reportRef: reportRefOf(kind, row._id),
    bookingRef: String(row.appointmentId),
    status: ready ? "ready" : "pending",
    format: "pdf",
    ...(ready
      ? await mint(row, member.organizationId)
      : { contentUrl: null, contentExpiresAt: null }),
    summary: {
      title: await visitTitle(row.appointmentId),
      collectedAt: row.drawnAt ?? row.performedAt,
      ...(ready ? { resultedAt: row.reviewedAt } : {}),
    },
  });
}

/** `POST /clinical/reports/{reportRef}/export`: a fresh URL on every call (exempt from the replay, so no `idempotent()`). */
export async function exportReport(req: Request, res: Response): Promise<void> {
  const { kind, row } = await ownedReport(req);
  const member = req.partnerMember;
  if (!member) throw new NotFoundError("Report not found");
  if (!reportIsReady(row))
    throw contractConflict("REPORT_NOT_READY", "The report is not ready yet");
  await audit(req, "exported", "Report", reportRefOf(kind, row._id), String(member._id));
  send(res, "Report export", { ...(await mint(row, member.organizationId)), format: "pdf" });
}
