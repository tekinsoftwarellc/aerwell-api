import { type InferSchemaType, Schema, model } from "mongoose";

/**
 * The consent wording staff read to the member before any audio is captured.
 * Bump the version whenever the text changes: every consent row keeps the
 * version and a snapshot of the exact text that was read.
 */
export const CONSENT_TEXT = {
  version: "2026-09-26.1",
  text:
    "Before we begin, I'd like to use live transcription for this visit. Your voice is " +
    "streamed to our secure transcription service only to produce a written transcript; " +
    "the audio itself is not stored. The transcript becomes part of your record. You can " +
    "ask me to stop at any time. Is that okay?",
} as const;
export const CONSENT_METHODS = ["verbal", "written"] as const;

const org = { type: String, required: true };
const ref = (name: string) => ({ type: Schema.Types.ObjectId, ref: name, required: true });

const consentSchema = new Schema(
  {
    organizationId: org,
    appointmentId: ref("Appointment"),
    memberId: ref("Member"),
    capturedById: ref("StaffMember"),
    capturedAt: { type: Date, required: true },
    method: { type: String, enum: CONSENT_METHODS, required: true },
    consentVersion: { type: String, required: true },
    consentText: { type: String, required: true },
    revokedAt: { type: Date, default: null },
    revokedById: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);
consentSchema.index({ organizationId: 1, appointmentId: 1, capturedAt: -1 });
// At most one active consent per appointment, even under concurrent capture.
consentSchema.index(
  { appointmentId: 1 },
  { unique: true, partialFilterExpression: { revokedAt: null } }
);
export const VisitConsent = model("VisitConsent", consentSchema);
export type VisitConsentData = InferSchemaType<typeof consentSchema>;

/**
 * One final transcript line. Audio is never stored: only the text Transcribe
 * returned. `speakerLabel` is the raw diarization label of ONE capture stream
 * (labels restart per stream), so speakers are keyed by capture + label.
 */
const segmentSchema = new Schema(
  {
    organizationId: org,
    appointmentId: ref("Appointment"),
    memberId: ref("Member"),
    captureIndex: { type: Number, required: true, min: 0 },
    sourceSequence: { type: Number, required: true, min: 0 },
    resultId: { type: String, required: true },
    speakerLabel: { type: String, required: true },
    startedAtMs: { type: Number, required: true, min: 0 },
    endedAtMs: { type: Number, required: true, min: 0 },
    spokenAt: { type: Date, required: true },
    text: { type: String, required: true },
    confidence: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false }
);
segmentSchema.index({ appointmentId: 1, captureIndex: 1, sourceSequence: 1 }, { unique: true });
export const TranscriptSegment = model("TranscriptSegment", segmentSchema);

/** One capture stream at a time per appointment; a stale heartbeat frees the lease. */
const leaseSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, required: true },
    captureId: { type: String, default: null },
    heartbeatAt: { type: Date, default: null },
    captureCount: { type: Number, default: 0 },
  },
  { versionKey: false }
);
export const CaptureLease = model("VisitCaptureLease", leaseSchema);

export const ACTION_TYPES = ["order", "add", "book", "review", "follow_up"] as const;
export const SUGGESTION_STATUSES = ["draft", "accepted", "rejected"] as const;
const textPair = new Schema(
  { title: { type: String, required: true }, detail: { type: String, required: true } },
  { _id: false }
);
/** A model-drafted next step. Never acts on the record; a clinician decides each one. */
const suggestionSchema = new Schema(
  {
    organizationId: org,
    appointmentId: ref("Appointment"),
    memberId: ref("Member"),
    actionType: { type: String, enum: ACTION_TYPES, required: true },
    draft: { type: textPair, required: true },
    final: { type: textPair, default: null },
    evidenceSegmentIds: { type: [Schema.Types.ObjectId], default: [] },
    status: { type: String, enum: SUGGESTION_STATUSES, default: "draft" },
    decidedById: { type: Schema.Types.ObjectId, default: null },
    decidedAt: { type: Date, default: null },
    modelId: { type: String, required: true },
    promptVersion: { type: String, required: true },
    position: { type: Number, required: true },
  },
  { timestamps: true }
);
suggestionSchema.index({ organizationId: 1, appointmentId: 1, position: 1 });
export const VisitSuggestion = model("VisitSuggestion", suggestionSchema);
