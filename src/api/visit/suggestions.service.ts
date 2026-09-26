import type { Request } from "express";
import mongoose, { type InferSchemaType } from "mongoose";
import { z } from "zod";
import { AppError, ConflictError, ValidationError } from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { logger } from "../../common/utils/logger.js";
import { Appointment } from "../appointment/appointment.model.js";
import { audit } from "../audit/audit.js";
import { Service } from "../service/service.model.js";
import { providerErrorName } from "./liveTranscription.js";
import { PROMPT_VERSION, getNextStepGenerator } from "./suggestions.adapter.js";
import { ACTION_TYPES, VisitSuggestion } from "./visit.model.js";
import { orderedSegments, speakerNames, visitTarget } from "./visit.service.js";

export const MAX_SUGGESTIONS = 8;
const SUGGESTABLE = ["in_progress", "completed"];

const itemSchema = z.object({
  title: z.string().trim().min(1).max(160),
  detail: z.string().trim().min(1).max(800),
  actionType: z.enum(ACTION_TYPES),
  evidenceSegmentIds: z.array(z.string()).min(1).max(20),
});
export type GroundedStep = z.infer<typeof itemSchema>;

/**
 * Each item is kept only if it is valid AND cites at least one real segment of
 * this visit; unknown ids are stripped first. One bad item never sinks the rest.
 */
export function groundNextSteps(body: unknown, knownSegmentIds: ReadonlySet<string>) {
  const items = (body as { nextSteps?: unknown } | null)?.nextSteps;
  if (!Array.isArray(items)) return [];
  return items
    .flatMap((item) => {
      const ids = (item as { evidenceSegmentIds?: unknown })?.evidenceSegmentIds;
      const parsed = itemSchema.safeParse({
        ...(item as object),
        evidenceSegmentIds: Array.isArray(ids)
          ? ids.filter((id): id is string => typeof id === "string" && knownSegmentIds.has(id))
          : [],
      });
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, MAX_SUGGESTIONS);
}

const unconfigured = () =>
  new AppError(
    "Next-step suggestions are not configured",
    503,
    true,
    undefined,
    "SUGGESTIONS_UNCONFIGURED"
  );

async function modelInput(row: { _id: unknown; serviceId: unknown; reasonDetail?: string | null }) {
  const segments = await orderedSegments(row._id);
  if (!segments.length)
    throw new ValidationError("There is no transcript to draft from", "TRANSCRIPT_EMPTY");
  const names = speakerNames(segments);
  const service = await Service.findById(row.serviceId).select("title").lean();
  return {
    known: new Set(segments.map((s) => String(s._id))),
    input: {
      visitReason: row.reasonDetail ?? null,
      serviceTitle: service?.title ?? null,
      segments: segments.map((s) => ({
        segmentId: String(s._id),
        speaker: names.get(`${s.captureIndex}:${s.speakerLabel}`) ?? "Speaker",
        text: s.text,
      })),
    },
  };
}

/** One generation per visit: a conditional claim, released again if the model fails. */
export async function generateNextSteps(req: Request) {
  const row = await visitTarget(req, true);
  const generator = getNextStepGenerator();
  if (!generator) throw unconfigured();
  if (!SUGGESTABLE.includes(row.status))
    throw new ValidationError("Start the visit first", "VISIT_NOT_STARTED");
  const { known, input } = await modelInput(row);
  const claimed = await Appointment.updateOne(
    { _id: row._id, "visit.startedAt": { $ne: null }, "visit.suggestionsRequestedAt": null },
    { $set: { "visit.suggestionsRequestedAt": new Date() } }
  );
  // matchedCount, not modifiedCount: the filter IS the claim (and a same-instant
  // re-write would report 0 modified even when it matched).
  if (!claimed.matchedCount)
    throw new ConflictError("Next steps were already drafted", undefined, "SUGGESTIONS_EXIST");
  let body: unknown;
  try {
    body = await generator.generate(input);
  } catch (error) {
    await Appointment.updateOne(
      { _id: row._id },
      { $set: { "visit.suggestionsRequestedAt": null } }
    );
    logger.warn(
      { appointmentId: String(row._id), providerErrorName: providerErrorName(error) },
      "Next-step generation failed"
    );
    throw new AppError(
      "Next steps could not be drafted; try again",
      502,
      true,
      undefined,
      "SUGGESTIONS_FAILED"
    );
  }
  const steps = groundNextSteps(body, known);
  const rows = await mongoose.connection.transaction(async (session) => {
    const created = await VisitSuggestion.create(
      steps.map((step, position) => ({
        organizationId: row.organizationId,
        appointmentId: row._id,
        memberId: row.memberId,
        actionType: step.actionType,
        draft: { title: step.title, detail: step.detail },
        evidenceSegmentIds: step.evidenceSegmentIds,
        modelId: generator.modelId,
        promptVersion: PROMPT_VERSION,
        position,
      })),
      { session, ordered: true }
    );
    await audit(
      req,
      "suggestions_generated",
      "VisitSuggestions",
      String(row._id),
      String(row.memberId),
      session
    );
    return created;
  });
  logger.info(
    { appointmentId: String(row._id), kept: rows.length, dropped: countOf(body) - rows.length },
    "Next steps drafted"
  );
  return { items: rows.map((doc) => view(doc.toObject())) };
}

const countOf = (body: unknown) => {
  const items = (body as { nextSteps?: unknown } | null)?.nextSteps;
  return Array.isArray(items) ? items.length : 0;
};

type SuggestionData = InferSchemaType<typeof VisitSuggestion.schema> & { _id: unknown };
function view(r: SuggestionData) {
  const shown = r.final ?? r.draft;
  return {
    id: String(r._id),
    actionType: r.actionType,
    title: shown.title,
    detail: shown.detail,
    draft: r.draft,
    edited: Boolean(
      r.final && (r.final.title !== r.draft.title || r.final.detail !== r.draft.detail)
    ),
    status: r.status,
    evidenceSegmentIds: r.evidenceSegmentIds.map(String),
    decidedAt: r.decidedAt,
  };
}

export async function listNextSteps(req: Request) {
  const row = await visitTarget(req);
  const rows = await VisitSuggestion.find({ appointmentId: row._id }).sort({ position: 1 }).lean();
  await audit(req, "viewed", "VisitSuggestions", String(row._id), String(row.memberId));
  return {
    configured: getNextStepGenerator() !== null,
    generated: Boolean(row.visit?.suggestionsRequestedAt),
    items: rows.map(view),
  };
}

/** Accept (optionally edited) or reject a draft, once. Nothing is written to the record. */
export async function decideNextStep(req: Request) {
  const { decision, title, detail } = req.body as {
    decision: "accepted" | "rejected";
    title?: string;
    detail?: string;
  };
  const row = await visitTarget(req, true);
  const current = await VisitSuggestion.findOne({
    _id: req.params["sid"],
    appointmentId: row._id,
  }).lean();
  if (!current)
    throw new AppError("Suggestion not found", 404, true, undefined, "SUGGESTION_NOT_FOUND");
  const final =
    decision === "accepted"
      ? { title: title ?? current.draft.title, detail: detail ?? current.draft.detail }
      : null;
  const updated = await mongoose.connection.transaction(async (session) => {
    const next = await VisitSuggestion.findOneAndUpdate(
      { _id: current._id, status: "draft" },
      { $set: { status: decision, final, decidedById: actor(req)._id, decidedAt: new Date() } },
      { new: true, session }
    );
    if (!next)
      throw new ConflictError("This suggestion was already decided", undefined, "ALREADY_DECIDED");
    await audit(
      req,
      `suggestion_${decision}`,
      "VisitSuggestion",
      String(next._id),
      String(row.memberId),
      session
    );
    return next;
  });
  return view(updated.toObject());
}
