import { afterEach, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { textTurn, useRelay } from "../../test/alfredFixture.js";
import { ModelCallError, getAlfredModel, setAlfredModel } from "./model.adapter.js";
import { AlfredRelayModel, unwrapJsonFence } from "./model.relay.js";

afterEach(() => {
  env.AI_PROVIDER = "bedrock";
  env.ALFRED_AI_TIMEOUT_MS = 60_000;
  setAlfredModel("smart", undefined);
  setAlfredModel("fast", undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tools = {
  tools: [
    {
      toolSpec: {
        name: "search_members",
        description: "Find members",
        inputSchema: { json: { type: "object", properties: { q: { type: "string" } } } },
      },
    },
  ],
};

it("maps a Bedrock-shaped tool round to the exact Alfred body", async () => {
  const { bodies, calls } = useRelay("smart", [
    { stopReason: "end_turn", content: [{ text: "Done." }], usage, latencyMs: 9 },
  ]);
  await new AlfredRelayModel("smart").converse(
    {
      system: [{ text: "You are Alfred AI." }],
      messages: [
        { role: "user", content: [{ text: "Find Ashton" }] },
        {
          role: "assistant",
          content: [
            { text: "Looking." },
            { toolUse: { toolUseId: "t1", name: "search_members", input: { q: "Ashton" } } },
          ],
        },
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "t1",
                content: [{ json: { result: [] } }],
                status: "success",
              },
            },
          ],
        },
      ],
      toolConfig: tools,
      inferenceConfig: { maxTokens: 1_500 },
    },
    "aerwell.chat"
  );
  expect(bodies[0]).toEqual({
    feature: "aerwell.chat",
    tier: "smart",
    system: "You are Alfred AI.",
    messages: [
      { role: "user", content: "Find Ashton" },
      {
        role: "assistant",
        content: "Looking.",
        toolCalls: [{ id: "t1", name: "search_members", input: { q: "Ashton" } }],
      },
      { role: "tool", toolCallId: "t1", content: '{"result":[]}' },
    ],
    tools: [
      {
        name: "search_members",
        description: "Find members",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
    maxTokens: 1_500,
  });
  expect(calls[0]?.url).toBe("https://alfred.test/api/v1/partner/ai/complete");
  expect(calls[0]?.headers).toMatchObject({
    // biome-ignore lint/style/useNamingConvention: an HTTP header name.
    Authorization: "Bearer tok",
    "x-contract-version": "1",
  });
});

const usage = { inputTokens: 10, outputTokens: 4 };

it("maps an Alfred tool_use reply to a ModelTurn with object inputs", async () => {
  useRelay("smart", [
    {
      stopReason: "tool_use",
      content: [
        { text: "Checking." },
        { toolUse: { toolUseId: "c1", name: "list_locations", input: {} } },
      ],
      usage,
      latencyMs: 12,
    },
  ]);
  const turn = await new AlfredRelayModel("smart").converse({ messages: [] });
  expect(turn).toEqual({
    stopReason: "tool_use",
    content: [
      { text: "Checking." },
      { toolUse: { toolUseId: "c1", name: "list_locations", input: {} } },
    ],
    usage,
    latencyMs: 12,
  });
});

it("refuses a tool call whose input is not an object", async () => {
  useRelay("smart", [
    {
      stopReason: "tool_use",
      content: [{ toolUse: { toolUseId: "c1", name: "x", input: [1] as never } }],
      usage,
      latencyMs: 1,
    },
  ]);
  const error = await new AlfredRelayModel("smart").converse({ messages: [] }).catch((e) => e);
  expect(error).toBeInstanceOf(ModelCallError);
  expect(error.providerErrorName).toBe("AI_INVALID_OUTPUT");
});

it("maps Alfred 429, 503 and other failures to scrubbed ModelCallError names", async () => {
  const { logger } = await import("../../common/utils/logger.js");
  const lines: string[] = [];
  for (const level of ["info", "warn", "error", "debug"] as const)
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    }) as never);
  useRelay("fast", [429, 503, 502, 400]);
  const model = new AlfredRelayModel("fast");
  const names: string[] = [];
  for (let i = 0; i < 4; i += 1)
    names.push(
      await model
        .converse({ messages: [{ role: "user", content: [{ text: "SECRET-PHI" }] }] })
        .then(() => "ok")
        .catch((e: ModelCallError) => e.providerErrorName)
    );
  expect(names).toEqual(["AI_RATE_LIMITED", "AI_UNAVAILABLE", "AI_FAILED", "AI_FAILED"]);
  expect(lines.join("\n")).not.toContain("SECRET-PHI");
  expect(lines.join("\n")).not.toContain("provider said");
});

it("sends no outputConfig: the JSON schema is appended to the system text", async () => {
  const { bodies } = useRelay("fast", [
    { stopReason: "end_turn", content: [{ text: "{}" }], usage, latencyMs: 1 },
  ]);
  await new AlfredRelayModel("fast").converse({
    system: [{ text: "Draft." }],
    messages: [{ role: "user", content: [{ text: "{}" }] }],
    outputConfig: {
      textFormat: {
        type: "json_schema",
        structure: { jsonSchema: { name: "s", schema: '{"type":"object"}' } },
      },
    },
  });
  expect(bodies[0]).not.toHaveProperty("outputConfig");
  expect(bodies[0]?.["system"]).toBe(
    'Draft.\n\nRespond with JSON only matching this schema: {"type":"object"}'
  );
  expect(bodies[0]?.["tier"]).toBe("fast");
});

it("times out as AI_FAILED", async () => {
  env.ALFRED_AI_TIMEOUT_MS = 50;
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith("/oauth/token"))
      return Promise.resolve(new Response('{"access_token":"tok","expires_in":300}'));
    return new Promise((_, reject) =>
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
    );
  });
  const error = await new AlfredRelayModel("fast").converse({ messages: [] }).catch((e) => e);
  expect(error).toBeInstanceOf(ModelCallError);
  expect(error.providerErrorName).toBe("AI_FAILED");
});

it("AI_PROVIDER=alfred selects the relay for both tiers and ignores BEDROCK_*", () => {
  expect(getAlfredModel("smart")).toBeNull();
  env.AI_PROVIDER = "alfred";
  expect(getAlfredModel("smart")).toBeInstanceOf(AlfredRelayModel);
  expect(getAlfredModel("fast")?.modelId).toBe("alfred:fast");
});

it("unwrapJsonFence: only a whole-reply fence is removed", () => {
  expect(unwrapJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  expect(unwrapJsonFence("```\n[]\n```")).toBe("[]");
  expect(unwrapJsonFence('{"a":1}')).toBe('{"a":1}');
  expect(unwrapJsonFence("Here:\n```json\n{}\n```")).toBe("Here:\n```json\n{}\n```");
});

it("a chat (no JSON schema) reply that is a code block passes through unchanged", async () => {
  const code = "```\nnpm run build\n```";
  useRelay("smart", [textTurn(code)]);
  const turn = await new AlfredRelayModel("smart").converse({
    messages: [{ role: "user", content: [{ text: "hi" }] }],
  });
  expect(turn.content).toEqual([{ text: code }]);
});
