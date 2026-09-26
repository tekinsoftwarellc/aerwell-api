import type { ContentBlock, Message } from "@aws-sdk/client-bedrock-runtime";
import type { Request } from "express";
import { AppError, NotFoundError } from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import type { CacheService } from "../../common/services/cache.service.js";
import { logger } from "../../common/utils/logger.js";
import { organizationTimeZone, organizationToday } from "../schedule/flags.js";
import type { StaffDocument } from "../staff/staff.model.js";
import { AlfredConversation, AlfredDraft, AlfredMessage, AlfredUsage } from "./alfred.model.js";
import { draftView } from "./drafts.service.js";
import {
  type AlfredModel,
  ModelCallError,
  aiUnconfigured,
  getAlfredModel,
} from "./model.adapter.js";
import { type ToolContext, runTool, toolConfig } from "./tools.js";

export const MAX_TOOL_ROUNDS = 6;
const HISTORY_TURNS = 20;
export const RATE = { windowSeconds: 600, chat: 30, suggestions: 20 } as const;

/** Per staff member (not per IP), across every device they use. */
export async function limitPerStaff(
  cache: CacheService,
  feature: "chat" | "suggestions",
  staff: StaffDocument
) {
  const count = await cache.increment(`alfred:${feature}:${String(staff._id)}`, RATE.windowSeconds);
  if (count > RATE[feature])
    throw new AppError(
      "Alfred AI is busy for you right now. Try again in a few minutes.",
      429,
      true,
      undefined,
      "AI_RATE_LIMITED"
    );
}

/** Keyed by org + staff + id: another staff member's conversation is simply not found. */
const mine = (req: Request, id = req.params["id"]) => ({
  _id: id,
  organizationId: actor(req).organizationId,
  staffId: actor(req)._id,
});
async function ownConversation(req: Request) {
  const row = await AlfredConversation.findOne(mine(req));
  if (!row) throw new NotFoundError("Conversation not found", "CONVERSATION_NOT_FOUND");
  return row;
}
const conversationView = (row: InstanceType<typeof AlfredConversation>) => ({
  id: String(row._id),
  title: row.title,
  lastMessageAt: row.lastMessageAt,
  createdAt: row.createdAt,
});

export async function createConversation(req: Request) {
  const staff = actor(req);
  return conversationView(
    await AlfredConversation.create({ organizationId: staff.organizationId, staffId: staff._id })
  );
}
export async function listConversations(req: Request) {
  const staff = actor(req);
  const rows = await AlfredConversation.find({
    organizationId: staff.organizationId,
    staffId: staff._id,
  })
    .sort({ updatedAt: -1, _id: -1 })
    .limit(30);
  return { items: rows.map(conversationView) };
}

/** Visible messages only: user and assistant text plus the server's own draft cards. */
async function messageViews(rows: InstanceType<typeof AlfredMessage>[]) {
  const ids = rows.flatMap((r) => r.draftIds);
  const drafts = new Map(
    (await AlfredDraft.find({ _id: { $in: ids } })).map((d) => [String(d._id), draftView(d)])
  );
  return rows.map((r) => ({
    id: String(r._id),
    role: r.role,
    text: r.text,
    drafts: r.draftIds.flatMap((d) => drafts.get(String(d)) ?? []),
    createdAt: r.createdAt,
  }));
}
export async function conversationMessages(req: Request) {
  const conversation = await ownConversation(req);
  const rows = await AlfredMessage.find({
    organizationId: conversation.organizationId,
    staffId: conversation.staffId,
    conversationId: conversation._id,
  }).sort({ createdAt: 1, _id: 1 });
  return { conversation: conversationView(conversation), messages: await messageViews(rows) };
}

async function systemPrompt(staff: StaffDocument) {
  const [today, timeZone] = await Promise.all([
    organizationToday(staff.organizationId),
    organizationTimeZone(staff.organizationId),
  ]);
  return [
    "You are Alfred AI, the assistant for staff at Aerwell, a longevity and wellness clinic.",
    `You are helping ${staff.firstName} ${staff.lastName}. Today is ${today} in ${timeZone}.`,
    "Use the tools to look things up. Only state facts that a tool returned in this conversation; never invent members, ids, results, times or prices.",
    "A tool error such as FORBIDDEN or NOT_FOUND means this staff member cannot see that data: say so plainly and do not guess.",
    "You cannot change anything yourself. For any change use a propose_* tool: it creates a draft the staff member confirms in the app. After proposing, say the draft is ready for their review; never say it was booked, saved, sent or done.",
    "Be brief and warm. Use plain text, no markdown tables.",
  ].join(" ");
}

async function history(conversationId: unknown, staff: StaffDocument): Promise<Message[]> {
  const rows = await AlfredMessage.find({
    organizationId: staff.organizationId,
    staffId: staff._id,
    conversationId,
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(HISTORY_TURNS);
  return rows.reverse().map((r) => ({ role: r.role, content: [{ text: r.text }] }));
}

const textOf = (content: ContentBlock[]) =>
  content
    .flatMap((b) => ("text" in b && b.text ? [b.text] : []))
    .join("\n")
    .trim();

interface LoopResult {
  reply: string;
  usage: { inputTokens: number; outputTokens: number; latencyMs: number; toolCalls: number };
}
async function runLoop(model: AlfredModel, system: string, messages: Message[], ctx: ToolContext) {
  const usage = { inputTokens: 0, outputTokens: 0, latencyMs: 0, toolCalls: 0 };
  const convo = [...messages];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const turn = await model.converse({
      system: [{ text: system }],
      messages: convo,
      toolConfig: toolConfig(),
      inferenceConfig: { maxTokens: 1_500, temperature: 0.2 },
    });
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    usage.latencyMs += turn.latencyMs;
    const uses = turn.content.flatMap((b) => ("toolUse" in b && b.toolUse ? [b.toolUse] : []));
    if (turn.stopReason !== "tool_use" || uses.length === 0)
      return { reply: textOf(turn.content), usage } satisfies LoopResult;
    convo.push({ role: "assistant", content: turn.content });
    const results: ContentBlock[] = [];
    // Serial on purpose: proposals and reads keep the order the model asked for.
    for (const use of uses) {
      usage.toolCalls += 1;
      const json = await runTool(ctx, String(use.name), use.input);
      results.push({
        toolResult: {
          toolUseId: use.toolUseId,
          content: [{ json }],
          status: "error" in json ? "error" : "success",
        },
      } as ContentBlock);
    }
    convo.push({ role: "user", content: results });
  }
  return { reply: "", usage } satisfies LoopResult;
}

const FALLBACK = "I couldn't finish that request. Could you try asking in a different way?";

export async function sendMessage(req: Request, cache: CacheService) {
  const staff = actor(req);
  const conversation = await ownConversation(req);
  const model = getAlfredModel("smart");
  if (!model) throw aiUnconfigured();
  await limitPerStaff(cache, "chat", staff);
  const text = (req.body as { text: string }).text;
  const ctx: ToolContext = {
    actor: { staff, requestId: req.requestId },
    conversationId: String(conversation._id),
    draftIds: [],
  };
  const usageRow = {
    organizationId: staff.organizationId,
    staffId: staff._id,
    feature: "chat",
    modelId: model.modelId,
  };
  let result: LoopResult;
  try {
    result = await runLoop(
      model,
      await systemPrompt(staff),
      [...(await history(conversation._id, staff)), { role: "user", content: [{ text }] }],
      ctx
    );
  } catch (error) {
    const errorName = error instanceof ModelCallError ? error.providerErrorName : "InternalError";
    logger.warn({ feature: "chat", errorName }, "Alfred model call failed");
    await AlfredUsage.create({ ...usageRow, outcome: "error", errorName });
    // A failed turn leaves no half-proposed writes behind.
    await AlfredDraft.updateMany(
      { _id: { $in: ctx.draftIds }, status: "pending" },
      { $set: { status: "cancelled", decidedAt: new Date() } }
    );
    throw new AppError(
      "Alfred AI could not answer right now. Please try again.",
      502,
      true,
      undefined,
      "AI_FAILED"
    );
  }
  await AlfredUsage.create({ ...usageRow, ...result.usage, outcome: "ok" });
  const base = {
    organizationId: staff.organizationId,
    staffId: staff._id,
    conversationId: conversation._id,
  };
  const userRow = await AlfredMessage.create({ ...base, role: "user", text });
  const assistantRow = await AlfredMessage.create({
    ...base,
    role: "assistant",
    text: (result.reply || FALLBACK).slice(0, 8_000),
    draftIds: ctx.draftIds,
  });
  await AlfredConversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        lastMessageAt: new Date(),
        ...(conversation.lastMessageAt ? {} : { title: text.slice(0, 60) }),
      },
    }
  );
  return {
    conversationId: String(conversation._id),
    messages: await messageViews([userRow, assistantRow]),
  };
}
