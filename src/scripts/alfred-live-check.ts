import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
/**
 * [USER] live check (never run by tests): one real Bedrock tool-use round trip
 * through the production adapter, on BOTH the FAST and SMART `us.` profiles, with
 * the app's own credentials. Synthetic data only; prints ids, stop reasons and
 * token counts, never content. Resolve the running principal first (W9 live check 1).
 *   npx tsx src/scripts/alfred-live-check.ts
 */
import { BedrockAlfredModel } from "../api/alfred/model.adapter.js";
import { env } from "../config/env.js";

const tool = {
  toolSpec: {
    name: "clinic_hours",
    description: "Opening hours of the clinic",
    inputSchema: { json: { type: "object", properties: {}, additionalProperties: false } },
  },
};
async function check(label: string, modelId: string | undefined) {
  if (!(env.BEDROCK_REGION && modelId)) return console.log(label, "UNCONFIGURED");
  const model = new BedrockAlfredModel(
    new BedrockRuntimeClient({ region: env.BEDROCK_REGION }),
    modelId
  );
  const messages: never[] = [
    { role: "user", content: [{ text: "When does the clinic open? Use the tool." }] },
  ] as never;
  const first = await model.converse({ messages, toolConfig: { tools: [tool] } as never });
  const use = first.content.find((b) => "toolUse" in b && b.toolUse)?.toolUse;
  if (first.stopReason !== "tool_use" || !use)
    return console.log(label, "NO TOOL CALL", first.stopReason);
  const second = await model.converse({
    toolConfig: { tools: [tool] } as never,
    messages: [
      ...messages,
      { role: "assistant", content: first.content },
      {
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: use.toolUseId,
              content: [{ json: { open: "07:00", close: "19:00" } }],
            },
          },
        ],
      },
    ] as never,
  });
  console.log(
    label,
    modelId,
    "tool:",
    use.name,
    "->",
    second.stopReason,
    "tokens:",
    first.usage,
    second.usage
  );
}
await check("FAST", env.BEDROCK_MODEL_FAST);
await check("SMART", env.BEDROCK_MODEL_SMART);
