import type { ContentBlock, Message } from "@aws-sdk/client-bedrock-runtime";
import {
  type AlfredAiMessage,
  type AlfredAiRequest,
  completeViaAlfred,
} from "../../common/services/alfredAiClient.js";
import type { AlfredModel, AlfredTier, ConverseRequest, ModelTurn } from "./model.adapter.js";

/**
 * AI_PROVIDER=alfred: the same Converse-shaped seam, answered by Alfred's
 * `/partner/ai/complete`. The tool loop, drafts and history stay in Aerwell; Alfred
 * only returns the next step. Converse `outputConfig` has no Alfred field, so its
 * JSON schema is appended to the system text (callers already parse and ground the
 * JSON item by item). Without enforced structured output the model often wraps its
 * JSON in a Markdown fence, so JSON-schema replies are unwrapped here, once.
 */
// Alfred's contract cap on one tool message (16k). Aerwell's own 12k cap is on the
// payload before its `{truncated, partialJson}` wrapper, so the wrapped text can exceed it.
const TOOL_RESULT_MAX = 16_000;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Aerwell emits `{json}` results today; a `{text}` block is passed through rather than sent as "null". */
const toolResultText = (block: unknown): string => {
  if (isPlainObject(block) && "json" in block) return JSON.stringify(block["json"] ?? null);
  if (isPlainObject(block) && typeof block["text"] === "string") return block["text"];
  return "null";
};

/** The inner text when the whole reply is one ``` / ```json fenced block, else the text unchanged. */
export function unwrapJsonFence(text: string): string {
  const m = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(text.trim());
  return m ? (m[1] ?? "").trim() : text;
}

const texts = (blocks: ContentBlock[] | undefined) =>
  (blocks ?? []).flatMap((b) => ("text" in b && b.text ? [b.text] : [])).join("\n");

function toAlfredMessages(messages: Message[]): AlfredAiMessage[] {
  return messages.flatMap((m): AlfredAiMessage[] => {
    const text = texts(m.content);
    if (m.role === "assistant") {
      const toolCalls = (m.content ?? []).flatMap((b) =>
        "toolUse" in b && b.toolUse
          ? [
              {
                id: String(b.toolUse.toolUseId),
                name: String(b.toolUse.name),
                input: isPlainObject(b.toolUse.input) ? b.toolUse.input : {},
              },
            ]
          : []
      );
      return [
        {
          role: "assistant",
          ...(text ? { content: text } : {}),
          ...(toolCalls.length ? { toolCalls } : {}),
        },
      ];
    }
    // Tool results answer the assistant's calls, so they come before any user text.
    const results = (m.content ?? []).flatMap((b): AlfredAiMessage[] =>
      "toolResult" in b && b.toolResult
        ? [
            {
              role: "tool",
              toolCallId: String(b.toolResult.toolUseId),
              content: toolResultText(b.toolResult.content?.[0]).slice(0, TOOL_RESULT_MAX),
            },
          ]
        : []
    );
    return text ? [...results, { role: "user", content: text }] : results;
  });
}

export function toAlfredRequest(
  request: ConverseRequest,
  tier: AlfredTier,
  feature: string
): AlfredAiRequest {
  const schema = request.outputConfig?.textFormat?.structure?.jsonSchema?.schema;
  const system = [
    texts(request.system as ContentBlock[] | undefined),
    schema ? `Respond with JSON only matching this schema: ${schema}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const tools = (request.toolConfig?.tools ?? []).flatMap((t) =>
    t.toolSpec
      ? [
          {
            name: String(t.toolSpec.name),
            description: t.toolSpec.description ?? "",
            inputSchema: t.toolSpec.inputSchema?.json,
          },
        ]
      : []
  );
  return {
    feature,
    tier,
    ...(system ? { system } : {}),
    messages: toAlfredMessages(request.messages ?? []),
    ...(tools.length ? { tools } : {}),
    ...(request.inferenceConfig?.maxTokens ? { maxTokens: request.inferenceConfig.maxTokens } : {}),
  };
}

export class AlfredRelayModel implements AlfredModel {
  readonly modelId: string;
  constructor(private readonly tier: AlfredTier) {
    this.modelId = `alfred:${tier}`;
  }

  async converse(request: ConverseRequest, feature = `aerwell.${this.tier}`): Promise<ModelTurn> {
    const started = Date.now();
    const reply = await completeViaAlfred(toAlfredRequest(request, this.tier, feature));
    const json = request.outputConfig?.textFormat?.type === "json_schema";
    const text = json && reply.content ? unwrapJsonFence(reply.content) : reply.content;
    const content: ContentBlock[] = [
      ...(text ? [{ text }] : []),
      ...reply.toolCalls.map(
        (c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.input } }) as ContentBlock
      ),
    ];
    return {
      stopReason: reply.stopReason,
      content,
      usage: reply.usage,
      latencyMs: reply.latencyMs ?? Date.now() - started,
    };
  }
}
