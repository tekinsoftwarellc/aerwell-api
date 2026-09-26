import type { Request } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { AppError, ConflictError, NotFoundError } from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import type { CacheService } from "../../common/services/cache.service.js";
import { logger } from "../../common/utils/logger.js";
import { appointmentTarget } from "../appointment/booking.service.js";
import { audit } from "../audit/audit.js";
import { memberTarget } from "../member/member.scope.js";
import { organizationToday } from "../schedule/flags.js";
import {
  AlfredSuggestion,
  AlfredUsage,
  SUGGESTION_ACTIONS,
  type SuggestionContext,
} from "./alfred.model.js";
import { limitPerStaff } from "./chat.service.js";
import { type Actor, type RouteInput, callRoute, prepareRoute } from "./dispatch.js";
import { ModelCallError, aiUnconfigured, getAlfredModel } from "./model.adapter.js";

/**
 * Contextual Alfred suggestions (member overview, visit, dashboard). The model
 * only sees what the acting staff member could read over HTTP: every source is a
 * route called as them, and a refused source is simply left out. Suggestions are
 * drafts: generating them writes nothing to the record; the server assigns every
 * id; one invalid item is dropped, never the whole batch.
 */
export const PROMPT_VERSION = "alfred-suggestions-v1";
export const MAX_SUGGESTIONS = 6;
const SOURCE_CHARS = 6_000;
export interface SuggestionTarget {
  context: SuggestionContext;
  memberId?: string | undefined;
  appointmentId?: string | undefined;
}
type Source = [key: string, route: string, input: RouteInput];

const memberSources = (id: string): Source[] => [
  ["profile", "GET /members/:id/overview", { params: { id } }],
  ["flags", "GET /members/:id/flags", { params: { id } }],
  ["appointments", "GET /members/:id/appointments", { params: { id }, query: { scope: "all" } }],
  ["labs", "GET /members/:id/lab-panels", { params: { id } }],
  ["protocols", "GET /members/:id/protocols", { params: { id } }],
];
const DASHBOARD_SOURCES: Source[] = [
  ["dashboard", "GET /dashboard/summary", {}],
  ["outlook", "GET /dashboard/outlook", {}],
  ["agenda", "GET /dashboard/agenda", {}],
];

const clip = (data: unknown) => {
  const text = JSON.stringify(data ?? null);
  return text.length > SOURCE_CHARS
    ? { partialJson: text.slice(0, SOURCE_CHARS) }
    : JSON.parse(text);
};
const refused = (o: { status: number; code: string; message: string }) =>
  new AppError(o.message, o.status, true, undefined, o.code);

/** Reads every source as the actor. The anchor (first source) must be readable. */
export async function gatherSources(a: Actor, target: SuggestionTarget) {
  let sources: Source[] = DASHBOARD_SOURCES;
  const found: Record<string, unknown> = {};
  if (target.context === "visit") {
    const appt = await callRoute(a, "GET /appointments/:id", {
      params: { id: target.appointmentId },
    });
    if (!appt.ok) throw refused(appt);
    found["appointment"] = clip(appt.data);
    const memberId = (appt.data as { member?: { id?: string } | null }).member?.id;
    sources = memberId ? memberSources(memberId) : [];
  } else if (target.context === "member_overview") {
    sources = memberSources(String(target.memberId));
  }
  for (const [key, route, input] of sources) {
    const outcome = await callRoute(a, route, input);
    if (outcome.ok) found[key] = clip(outcome.data);
    else if (Object.keys(found).length === 0) throw refused(outcome);
  }
  return found;
}

export const suggestionsJsonSchema = (keys: string[]) => ({
  type: "object",
  additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "actionType", "sources"],
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          actionType: { type: "string", enum: [...SUGGESTION_ACTIONS] },
          sources: { type: "array", minItems: 1, items: { type: "string", enum: keys } },
        },
      },
    },
  },
});
const itemSchema = z.object({
  title: z.string().trim().min(1).max(160),
  detail: z.string().trim().min(1).max(600),
  actionType: z.enum(SUGGESTION_ACTIONS),
  sources: z.array(z.string()).min(1).max(10),
});
/** Keep each valid item that cites at least one real source; drop only the bad ones. */
export function groundSuggestions(body: unknown, known: ReadonlySet<string>) {
  const items = (body as { suggestions?: unknown } | null)?.suggestions;
  if (!Array.isArray(items)) return [];
  return items
    .flatMap((item) => {
      const cited = (item as { sources?: unknown })?.sources;
      const parsed = itemSchema.safeParse({
        ...(item as object),
        sources: Array.isArray(cited)
          ? cited.filter((k) => typeof k === "string" && known.has(k))
          : [],
      });
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, MAX_SUGGESTIONS);
}

const SYSTEM = [
  "You are Alfred AI, suggesting next actions for a staff member at Aerwell, a longevity and wellness clinic.",
  "Use only the supplied data. Never invent facts, values, dates, doses or diagnoses.",
  "Each suggestion has a short title, a one-sentence detail, an actionType (schedule, review, follow_up, note or flag) and the source keys it is based on.",
  `Return at most ${MAX_SUGGESTIONS}, most important first, or an empty list when nothing applies. Nothing is done automatically: staff decide.`,
].join(" ");

const scopeKey = (staff: Actor["staff"], t: SuggestionTarget) => ({
  organizationId: staff.organizationId,
  staffId: staff._id,
  context: t.context,
  memberId: t.memberId ?? null,
  appointmentId: t.appointmentId ?? null,
});
const view = (row: {
  _id: unknown;
  title: string;
  detail: string;
  actionType: string;
  status: string;
  createdAt?: Date;
}) => ({
  id: String(row._id),
  title: row.title,
  detail: row.detail,
  actionType: row.actionType,
  status: row.status,
  createdAt: row.createdAt,
});

export async function generateSuggestions(req: Request, cache: CacheService) {
  const staff = actor(req);
  const target = req.body as SuggestionTarget;
  const model = getAlfredModel("fast");
  if (!model) throw aiUnconfigured();
  await limitPerStaff(cache, "suggestions", staff);
  const sources = await gatherSources({ staff, requestId: req.requestId }, target);
  const keys = Object.keys(sources);
  const usageRow = {
    organizationId: staff.organizationId,
    staffId: staff._id,
    feature: "suggestions",
    modelId: model.modelId,
  };
  let body: unknown;
  try {
    const turn = await model.converse({
      system: [{ text: SYSTEM }],
      messages: [
        {
          role: "user",
          content: [
            {
              text: JSON.stringify({
                context: target.context,
                today: await organizationToday(staff.organizationId),
                sources,
              }),
            },
          ],
        },
      ],
      inferenceConfig: { temperature: 0, maxTokens: 1_500 },
      outputConfig: {
        textFormat: {
          type: "json_schema",
          structure: {
            jsonSchema: {
              name: "alfred_suggestions_v1",
              description: "Draft next actions for staff review",
              schema: JSON.stringify(suggestionsJsonSchema(keys)),
            },
          },
        },
      },
    });
    await AlfredUsage.create({
      ...usageRow,
      ...turn.usage,
      latencyMs: turn.latencyMs,
      outcome: "ok",
    });
    const text = turn.content.find((b) => "text" in b && b.text)?.text ?? "";
    body = JSON.parse(text);
  } catch (error) {
    const errorName =
      error instanceof ModelCallError ? error.providerErrorName : "ModelOutputError";
    logger.warn({ feature: "suggestions", errorName }, "Alfred suggestions failed");
    await AlfredUsage.create({ ...usageRow, outcome: "error", errorName });
    throw new AppError(
      "Alfred AI could not draft suggestions right now.",
      502,
      true,
      undefined,
      "AI_FAILED"
    );
  }
  const batchId = new Types.ObjectId();
  const rows = await AlfredSuggestion.insertMany(
    groundSuggestions(body, new Set(keys)).map((item) => ({
      ...scopeKey(staff, target),
      ...item,
      batchId,
    }))
  );
  await auditSuggestions(req, target, String(batchId));
  return {
    configured: true,
    generatedAt: new Date(),
    items: rows.map((r) => view(r)),
    done: 0,
    total: rows.length,
  };
}

/** Before showing stored suggestions, the anchor must still be in the actor's scope. */
async function assertAnchor(a: Actor, target: SuggestionTarget) {
  if (target.context === "dashboard") return;
  const key = target.context === "visit" ? "GET /appointments/:id" : "GET /members/:id/overview";
  const id = target.context === "visit" ? target.appointmentId : target.memberId;
  const prepared = await prepareRoute(a, key, { params: { id } });
  if (!("req" in prepared)) throw refused(prepared);
  if (target.context === "visit") await appointmentTarget(prepared.req);
  else await memberTarget(prepared.req);
}
async function auditSuggestions(req: Request, target: SuggestionTarget, targetId: string) {
  if (target.context !== "dashboard")
    await audit(req, "viewed", "AlfredSuggestions", targetId, target.memberId);
}

export async function listSuggestions(req: Request) {
  const staff = actor(req);
  const target = req.query as unknown as SuggestionTarget;
  await assertAnchor({ staff, requestId: req.requestId }, target);
  const latest = await AlfredSuggestion.findOne(scopeKey(staff, target)).sort({
    createdAt: -1,
    _id: -1,
  });
  const rows = latest
    ? await AlfredSuggestion.find({ ...scopeKey(staff, target), batchId: latest.batchId }).sort({
        _id: 1,
      })
    : [];
  if (latest) await auditSuggestions(req, target, String(latest.batchId));
  const shown = rows.filter((r) => r.status !== "dismissed");
  return {
    configured: Boolean(getAlfredModel("fast")),
    generatedAt: latest?.createdAt ?? null,
    items: shown.map(view),
    done: rows.filter((r) => r.status === "done").length,
    total: rows.length,
  };
}

export async function actOnSuggestion(req: Request) {
  const staff = actor(req);
  const mine = { _id: req.params["sid"], organizationId: staff.organizationId, staffId: staff._id };
  const row = await AlfredSuggestion.findOneAndUpdate(
    { ...mine, status: "open" },
    { $set: { status: (req.body as { status: string }).status, decidedAt: new Date() } },
    { new: true }
  );
  if (row) return view(row);
  if (await AlfredSuggestion.exists(mine))
    throw new ConflictError("This suggestion was already decided", undefined, "ALREADY_DECIDED");
  throw new NotFoundError("Suggestion not found", "SUGGESTION_NOT_FOUND");
}
