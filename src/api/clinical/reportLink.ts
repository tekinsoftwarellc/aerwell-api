import type { Request } from "express";
import type { ClientSession, Model } from "mongoose";
import { ConflictError, NotFoundError } from "../../common/errors/AppError.js";
import {
  REPORT_MODELS,
  type ReportFacts,
  type ReportKind,
  reportIsReady,
  reportReadyEvent,
  visitTitle,
} from "../alfred-partner/clinicalReport.js";
import { enqueue, linkedAccount } from "../alfred-partner/outbox/partnerOutbox.service.js";
import { Appointment } from "../appointment/appointment.model.js";
import { Service } from "../service/service.model.js";
import type { MemberDocument } from "../member/member.model.js";
import { auditedWrite, byMember, clinicalMember, withoutDocument } from "./clinical.shared.js";

type Row = ReportFacts & { memberId: unknown };

/**
 * The visit must be this member's, in this organization, not cancelled and for a clinical service:
 * its `_id` becomes the partner `bookingRef`, and Alfred ignores a report for any other visit.
 */
export async function assertVisit(member: MemberDocument, appointmentId: unknown) {
  const visit = await Appointment.findOne({
    _id: appointmentId,
    organizationId: member.organizationId,
    memberId: member._id,
  })
    .select("serviceId status")
    .lean();
  if (!visit) throw new NotFoundError("Visit not found");
  if (
    visit.status === "cancelled" ||
    !(await Service.exists({ _id: visit.serviceId, fulfilment: "clinical" }))
  )
    throw new ConflictError(
      "The visit must be an active clinical visit",
      undefined,
      "VISIT_NOT_CLINICAL"
    );
}

/**
 * Tell Alfred the report can be read, in the same transaction as the change that made it ready, so
 * a failure aborts the review instead of silently losing the event (it is Alfred's only source of
 * the reportRef). Nothing is sent until reviewed, linked to a visit and a PDF is attached. The visit
 * is touched so the orders stream (keyed on updatedAt) carries the new status too.
 */
export async function enqueueReportReady(kind: ReportKind, row: Row, session: ClientSession) {
  if (!reportIsReady(row)) return;
  const accountId = await linkedAccount(row.memberId, session);
  if (!accountId) return;
  await enqueue(
    reportReadyEvent(accountId, kind, row, await visitTitle(row.appointmentId)),
    session
  );
  await Appointment.updateOne(
    { _id: row.appointmentId },
    { $set: { updatedAt: new Date() } },
    { session }
  );
}

/** Staff "link to visit". A report that is already ready keeps its visit: Alfred holds that bookingRef. */
export const linkVisit = (kind: ReportKind) => async (req: Request) => {
  const member = await clinicalMember(req, "LABS_SCANS", true);
  const model = REPORT_MODELS[kind] as unknown as Model<Row>;
  const appointmentId = String(req.body.appointmentId);
  const filter = { ...byMember(member), _id: req.params[kind === "lab" ? "panelId" : "scanId"] };
  await assertVisit(member, appointmentId);
  const targetType = kind === "lab" ? "LabPanel" : "Scan";
  const row = await auditedWrite(req, member, { action: "linked", targetType }, async (session) => {
    const prior = await model.findOne(filter).session(session).lean();
    if (!prior) throw new NotFoundError(`${targetType} not found`);
    if (reportIsReady(prior) && String(prior.appointmentId) !== appointmentId)
      throw new ConflictError(
        "A ready report cannot move to another visit",
        undefined,
        "REPORT_READY"
      );
    const updated = await model
      .findOneAndUpdate(filter, { $set: { appointmentId } }, { new: true, session })
      .lean();
    if (!updated) throw new NotFoundError(`${targetType} not found`);
    if (String(prior.appointmentId) !== appointmentId)
      await enqueueReportReady(kind, updated, session);
    return updated as Row & { _id: unknown };
  });
  return withoutDocument(row);
};
