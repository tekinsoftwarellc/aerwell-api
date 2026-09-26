import { Router } from "express";
import { z } from "zod";
import { objectId, secured } from "../../common/http.js";
import type { CacheService } from "../../common/services/cache.service.js";
import { SUGGESTION_CONTEXTS } from "./alfred.model.js";
import {
  conversationMessages,
  createConversation,
  listConversations,
  sendMessage,
} from "./chat.service.js";
import { cancelDraft, confirmDraft, getDraft } from "./drafts.service.js";
import { getAlfredModel } from "./model.adapter.js";
import { actOnSuggestion, generateSuggestions, listSuggestions } from "./suggestions.service.js";

const id = z.object({ id: objectId }).strict();
const draftId = z.object({ draftId: objectId }).strict();
const messageBody = z.object({ text: z.string().trim().min(1).max(4000) }).strict();
const confirmBody = z.object({ edits: z.record(z.string().max(8000)).optional() }).strict();
const target = z
  .object({
    context: z.enum(SUGGESTION_CONTEXTS),
    memberId: objectId.optional(),
    appointmentId: objectId.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.context === "member_overview" && !v.memberId)
      ctx.addIssue({ code: "custom", path: ["memberId"], message: "memberId is required" });
    if (v.context === "visit" && !v.appointmentId)
      ctx.addIssue({
        code: "custom",
        path: ["appointmentId"],
        message: "appointmentId is required",
      });
    if (v.context !== "member_overview" && v.memberId)
      ctx.addIssue({ code: "custom", path: ["memberId"], message: "Only for member_overview" });
    if (v.context !== "visit" && v.appointmentId)
      ctx.addIssue({ code: "custom", path: ["appointmentId"], message: "Only for visit" });
  });
const actionParams = z.object({ sid: objectId }).strict();
const actionBody = z.object({ status: z.enum(["done", "dismissed"]) }).strict();

/** Any signed-in staff member; every tool and source enforces its own route's permission. */
export function createAlfredRouter(cache: CacheService) {
  const r = Router();
  secured(r, "get", "/alfred/config", null, {}, () =>
    Promise.resolve({
      chat: Boolean(getAlfredModel("smart")),
      suggestions: Boolean(getAlfredModel("fast")),
    })
  );
  secured(r, "get", "/alfred/conversations", null, {}, listConversations);
  secured(r, "post", "/alfred/conversations", null, {}, createConversation, 201);
  secured(
    r,
    "get",
    "/alfred/conversations/:id/messages",
    null,
    { params: id },
    conversationMessages
  );
  secured(
    r,
    "post",
    "/alfred/conversations/:id/messages",
    null,
    { params: id, body: messageBody },
    (req) => sendMessage(req, cache)
  );
  secured(r, "get", "/alfred/drafts/:draftId", null, { params: draftId }, getDraft);
  secured(
    r,
    "post",
    "/alfred/drafts/:draftId/confirm",
    null,
    { params: draftId, body: confirmBody },
    confirmDraft
  );
  secured(r, "post", "/alfred/drafts/:draftId/cancel", null, { params: draftId }, cancelDraft);
  secured(r, "get", "/alfred/suggestions", null, { query: target }, listSuggestions);
  secured(
    r,
    "post",
    "/alfred/suggestions",
    null,
    { body: target },
    (req) => generateSuggestions(req, cache),
    201
  );
  secured(
    r,
    "post",
    "/alfred/suggestions/:sid/action",
    null,
    { params: actionParams, body: actionBody },
    actOnSuggestion
  );
  return r;
}
