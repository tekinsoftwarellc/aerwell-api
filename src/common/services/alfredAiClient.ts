import { z } from "zod";
import { ModelCallError } from "../../api/alfred/model.adapter.js";
import { env } from "../../config/env.js";
import { logger } from "../utils/logger.js";
import { getServiceToken } from "./serviceTokenClient.js";

/**
 * Aerwell -> Alfred `POST /api/v1/partner/ai/complete` (scope `partner.ai.complete`):
 * one chat-completion step with tools. Alfred picks the model and never runs a tool.
 *
 * Bodies are PHI and headers hold a bearer: NOTHING about a request or response is
 * logged, only a status or error name. Every failure is a `ModelCallError` whose name
 * is one of AI_RATE_LIMITED / AI_UNAVAILABLE / AI_FAILED / AI_INVALID_OUTPUT.
 */
const SCOPE = "partner.ai.complete";

export type AlfredAiMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content?: string;
      toolCalls?: { id: string; name: string; input: Record<string, unknown> }[];
    }
  | { role: "tool"; toolCallId: string; content: string };
export interface AlfredAiRequest {
  feature: string;
  tier: "fast" | "smart";
  system?: string;
  messages: AlfredAiMessage[];
  tools?: { name: string; description: string; inputSchema: unknown }[];
  maxTokens?: number;
}

const completionSchema = z.object({
  stopReason: z.string().min(1),
  content: z.string().nullable(),
  toolCalls: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      // z.record refuses arrays and scalars: a tool input is always an object.
      input: z.record(z.unknown()),
    })
  ),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  latencyMs: z.number().optional(),
});
export type AlfredAiCompletion = z.infer<typeof completionSchema>;

const fail = (name: string, detail: Record<string, unknown> = {}): never => {
  logger.warn({ code: name, ...detail }, "alfred ai relay failed");
  throw new ModelCallError(name);
};

export async function completeViaAlfred(body: AlfredAiRequest): Promise<AlfredAiCompletion> {
  if (!env.ALFRED_API_URL) return fail("AI_UNAVAILABLE", { reason: "no-base-url" });
  let token: string;
  try {
    token = await getServiceToken("alfred-api", SCOPE);
  } catch {
    return fail("AI_UNAVAILABLE", { reason: "token" });
  }
  let res: Response;
  try {
    res = await fetch(`${env.ALFRED_API_URL}/api/v1/partner/ai/complete`, {
      method: "POST",
      headers: {
        // biome-ignore lint/style/useNamingConvention: an HTTP header name.
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-contract-version": "1",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(env.ALFRED_AI_TIMEOUT_MS),
    });
  } catch (error) {
    return fail("AI_FAILED", { errorName: error instanceof Error ? error.name : "unknown" });
  }
  if (res.status === 429) return fail("AI_RATE_LIMITED", { status: 429 });
  if (res.status === 503) return fail("AI_UNAVAILABLE", { status: 503 });
  if (!res.ok) return fail("AI_FAILED", { status: res.status });
  let envelope: unknown;
  try {
    envelope = await res.json();
  } catch {
    return fail("AI_INVALID_OUTPUT", { reason: "unreadable-body" });
  }
  // Alfred answers in its ServiceResponse envelope; the completion is `data`.
  const parsed = completionSchema.safeParse((envelope as { data?: unknown } | null)?.data);
  return parsed.success ? parsed.data : fail("AI_INVALID_OUTPUT", { reason: "shape" });
}
