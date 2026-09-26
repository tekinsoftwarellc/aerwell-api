import type { Request } from "express";
import mongoose, { type ClientSession } from "mongoose";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import type { AppointmentDocument } from "../appointment/appointment.model.js";
import { Appointment } from "../appointment/appointment.model.js";
import { appointmentTarget } from "../appointment/booking.service.js";
import { audit } from "../audit/audit.js";
import { Member } from "../member/member.model.js";
import { memberScope, permissionsOf } from "../member/member.scope.js";
import { permits } from "../role/permission.js";
import { StaffMember } from "../staff/staff.model.js";
import { getNextStepGenerator } from "./suggestions.adapter.js";
import { getTranscriber } from "./transcribe.adapter.js";
import { emitVisitSignal } from "./visit.events.js";
import {
  CONSENT_TEXT,
  CaptureLease,
  TranscriptSegment,
  VisitConsent,
  VisitSuggestion,
} from "./visit.model.js";

/** A capture whose heartbeat is older than this no longer holds the lease. */
export const LEASE_STALE_MS = 45_000;
const CONSENTABLE = ["checked_in", "in_progress"];

type ActorRequest = Pick<Request, "staff" | "requestId" | "params" | "permission" | "permissions">;

/**
 * The appointment in :id for the visit workspace: APPOINTMENTS scope (route guard),
 * MEMBER_RECORDS scope, and CLINICAL_NOTES level + own scope, because the visit
 * holds clinical content (consent, transcript, summary, suggestions).
 */
export async function visitTarget(req: ActorRequest, write = false) {
  const permissions = await permissionsOf(req as Request);
  if (!permits(permissions.CLINICAL_NOTES.level, write ? "edit" : "view"))
    throw new ForbiddenError("Visits need Clinical Notes access", "CLINICAL_NOTES_REQUIRED");
  const row = await appointmentTarget(req as Request);
  const inScope = await Member.exists({
    _id: row.memberId,
    ...(await memberScope(req as Request, ["CLINICAL_NOTES"])),
  });
  if (!inScope) throw new NotFoundError("Appointment not found");
  return row;
}

export const activeConsent = (appointmentId: unknown, session: ClientSession | null = null) =>
  VisitConsent.findOne({ appointmentId, revokedAt: null }).session(session).lean();

export async function captureActive(appointmentId: unknown) {
  return Boolean(
    await CaptureLease.exists({
      _id: appointmentId,
      captureId: { $ne: null },
      heartbeatAt: { $gt: new Date(Date.now() - LEASE_STALE_MS) },
    })
  );
}

async function consentView(appointmentId: unknown) {
  const consent = await activeConsent(appointmentId);
  if (!consent) return null;
  const by = await StaffMember.findById(consent.capturedById)
    .select("firstName lastName titlePrefix")
    .lean();
  return {
    id: String(consent._id),
    method: consent.method,
    capturedAt: consent.capturedAt,
    consentVersion: consent.consentVersion,
    capturedBy: by
      ? { name: `${by.titlePrefix ?? ""} ${by.firstName} ${by.lastName}`.trim() }
      : null,
  };
}

export async function visitState(req: Request) {
  const row = await visitTarget(req);
  const [consent, active, segmentCount, suggestionCount] = await Promise.all([
    consentView(row._id),
    captureActive(row._id),
    TranscriptSegment.countDocuments({ appointmentId: row._id }),
    VisitSuggestion.countDocuments({ appointmentId: row._id }),
  ]);
  const visit = row.visit;
  await audit(req, "viewed", "Visit", String(row._id), String(row.memberId));
  return {
    appointmentId: String(row._id),
    memberId: String(row.memberId),
    status: row.status,
    startedAt: visit?.startedAt ?? null,
    endedAt: visit?.endedAt ?? null,
    durationSec: durationSec(row),
    summary: visit?.summary ?? null,
    consent,
    consentText: CONSENT_TEXT,
    capture: { active },
    segmentCount,
    transcription: { configured: getTranscriber() !== null },
    suggestions: { configured: getNextStepGenerator() !== null, count: suggestionCount },
  };
}

export function durationSec(row: Pick<AppointmentDocument, "visit">) {
  const { startedAt, endedAt } = row.visit ?? {};
  return startedAt && endedAt ? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000) : null;
}

function withAudit<T extends { _id: unknown }>(
  req: Request,
  row: AppointmentDocument,
  action: string,
  work: (session: ClientSession) => Promise<T>
) {
  return mongoose.connection.transaction(async (session) => {
    const result = await work(session);
    await audit(req, action, "VisitConsent", String(result._id), String(row.memberId), session);
    return result;
  });
}

export async function recordConsent(req: Request) {
  const { method, consentVersion } = req.body as { method: string; consentVersion: string };
  const row = await visitTarget(req, true);
  if (!CONSENTABLE.includes(row.status))
    throw new ValidationError(
      "Consent is recorded once the member is checked in",
      "VISIT_NOT_ACTIVE"
    );
  if (consentVersion !== CONSENT_TEXT.version)
    throw new ValidationError(
      "The consent wording has changed; reload it",
      "CONSENT_VERSION_STALE"
    );
  try {
    const consent = await withAudit(req, row, "consent_recorded", async (session) => {
      const [created] = await VisitConsent.create(
        [
          {
            organizationId: row.organizationId,
            appointmentId: row._id,
            memberId: row.memberId,
            capturedById: actor(req)._id,
            capturedAt: new Date(),
            method,
            consentVersion: CONSENT_TEXT.version,
            consentText: CONSENT_TEXT.text,
          },
        ],
        { session }
      );
      return created as NonNullable<typeof created>;
    });
    return consent.toObject();
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      throw new ConflictError("Consent is already recorded", undefined, "CONSENT_ALREADY_RECORDED");
    throw error;
  }
}

/** Revoking consent stops any live capture at once (in-process signal + heartbeat). */
export async function revokeConsent(req: Request) {
  const row = await visitTarget(req, true);
  const revoked = await withAudit(req, row, "consent_revoked", async (session) => {
    const updated = await VisitConsent.findOneAndUpdate(
      { appointmentId: row._id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedById: actor(req)._id } },
      { new: true, session }
    );
    if (!updated) throw new ConflictError("No active consent", undefined, "NO_ACTIVE_CONSENT");
    return updated;
  });
  emitVisitSignal(String(row._id), "consent_revoked");
  return revoked.toObject();
}

export async function updateVisit(req: Request) {
  const { summary } = req.body as { summary: string };
  const row = await visitTarget(req, true);
  const updated = await Appointment.findOneAndUpdate(
    { _id: row._id, "visit.startedAt": { $ne: null } },
    { $set: { "visit.summary": summary } },
    { new: true }
  );
  if (!updated) throw new ValidationError("Start the visit first", "VISIT_NOT_STARTED");
  await audit(req, "summary_updated", "Visit", String(row._id), String(row.memberId));
  return { summary: updated.visit?.summary ?? null };
}

/** "Speaker N" by first appearance; labels restart per capture stream, so key by both. */
export function speakerNames(segments: { captureIndex: number; speakerLabel: string }[]) {
  const names = new Map<string, string>();
  for (const s of segments) {
    const key = `${s.captureIndex}:${s.speakerLabel}`;
    if (!names.has(key)) names.set(key, `Speaker ${names.size + 1}`);
  }
  return names;
}

export function orderedSegments(appointmentId: unknown) {
  return TranscriptSegment.find({ appointmentId })
    .sort({ captureIndex: 1, sourceSequence: 1 })
    .lean();
}

export async function transcript(req: Request) {
  const row = await visitTarget(req);
  const segments = await orderedSegments(row._id);
  const names = speakerNames(segments);
  await audit(req, "viewed", "VisitTranscript", String(row._id), String(row.memberId));
  return {
    appointmentId: String(row._id),
    retention: "transcript_only",
    segments: segments.map((s) => ({
      id: String(s._id),
      captureIndex: s.captureIndex,
      speaker: names.get(`${s.captureIndex}:${s.speakerLabel}`),
      spokenAt: s.spokenAt,
      startedAtMs: s.startedAtMs,
      endedAtMs: s.endedAtMs,
      text: s.text,
    })),
  };
}
