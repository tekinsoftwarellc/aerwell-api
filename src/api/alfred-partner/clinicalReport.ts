import type { ClientSession } from "mongoose";
import { Appointment } from "../appointment/appointment.model.js";
import { LabPanel, Scan } from "../clinical/records.model.js";
import { Service } from "../service/service.model.js";
import type { OutboxEvent } from "./outbox/partnerOutbox.service.js";

/** A report is a lab panel or a scan; its partner `reportRef` is the prefixed id (opaque to Alfred). */
export type ReportKind = "lab" | "scan";
/** Both models, seen through the one query shape this module uses (their union is not callable). */
interface Query<T> {
  select(fields: string): { session(s: ClientSession | null): { lean(): Promise<T[]> } };
}
export interface ReportModel {
  find(filter: object): Query<{ appointmentId?: unknown }>;
  findOne(filter: object): { lean(): Promise<unknown> };
}
export const REPORT_MODELS: Record<ReportKind, ReportModel> = {
  lab: LabPanel as unknown as ReportModel,
  scan: Scan as unknown as ReportModel,
};
const REF = /^(lab|scan)_([a-f\d]{24})$/;

export const reportRefOf = (kind: ReportKind, id: unknown) => `${kind}_${String(id)}`;
export function parseReportRef(ref: string): { kind: ReportKind; id: string } | null {
  const match = REF.exec(ref);
  return match ? { kind: match[1] as ReportKind, id: match[2] as string } : null;
}

export interface ReportFacts {
  _id: unknown;
  appointmentId?: unknown;
  documentUploadId?: unknown;
  reviewStatus?: string | null;
  reviewedAt?: Date | null;
  withdrawnAt?: Date | null;
}
/** Ready = reviewed by a clinician, tied to a visit, with the PDF attached, and not withdrawn. */
export const reportIsReady = (row: ReportFacts) =>
  row.reviewStatus === "reviewed" &&
  Boolean(row.appointmentId) &&
  Boolean(row.documentUploadId) &&
  !row.withdrawnAt;

/** `clinical.report_ready` (contract §7). Display title and dates only: never a result value. */
export function reportReadyEvent(
  accountId: string,
  kind: ReportKind,
  row: ReportFacts,
  title: string
): OutboxEvent {
  const ref = reportRefOf(kind, row._id);
  const resultedAt = row.reviewedAt ?? new Date();
  return {
    type: "clinical.report_ready",
    occurredAt: new Date(),
    accountId,
    resource: { kind: "report", ref },
    payload: {
      reportRef: ref,
      bookingRef: String(row.appointmentId),
      status: "ready",
      format: "pdf",
      resultedAt,
      summary: { title },
    },
  };
}

/** Appointments (of one org) that already have a ready report. Two queries however many ids. */
export async function readyAppointmentIds(
  organizationId: string,
  appointmentIds: unknown[],
  session?: ClientSession | null
): Promise<Set<string>> {
  if (!appointmentIds.length) return new Set();
  const filter = {
    organizationId,
    appointmentId: { $in: appointmentIds },
    reviewStatus: "reviewed",
    documentUploadId: { $ne: null },
    withdrawnAt: null,
  };
  const rows = await Promise.all(
    Object.values(REPORT_MODELS).map((m) =>
      m
        .find(filter)
        .select("appointmentId")
        .session(session ?? null)
        .lean()
    )
  );
  return new Set(rows.flat().map((r) => String(r.appointmentId)));
}

/** The clinical status vocabulary of §5.11, derived from the visit and whether a report is ready. */
export function clinicalStatus(visitStatus: string, hasReadyReport: boolean): string {
  if (visitStatus === "cancelled") return "cancelled";
  if (hasReadyReport) return "report_ready";
  if (visitStatus === "completed") return "completed";
  if (visitStatus === "checked_in" || visitStatus === "in_progress") return "sample_taken";
  return "booked";
}

/** The service title of the visit a report belongs to: display metadata, never a value. */
export async function visitTitle(appointmentId: unknown): Promise<string> {
  const visit = await Appointment.findById(appointmentId).select("serviceId").lean();
  const service = visit && (await Service.findById(visit.serviceId).select("title").lean());
  return service?.title ?? "Clinical report";
}
