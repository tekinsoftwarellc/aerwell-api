import { afterEach, expect, it } from "vitest";
import { env } from "../../config/env.js";
import { resetModels, textTurn, useRelay } from "../../test/alfredFixture.js";
import {
  RelayNextStepGenerator,
  getNextStepGenerator,
  setNextStepGenerator,
} from "./suggestions.adapter.js";

afterEach(() => {
  env.AI_PROVIDER = "bedrock";
  setNextStepGenerator(undefined);
  resetModels();
});

const input = {
  visitReason: null,
  serviceTitle: null,
  segments: [{ segmentId: "s1", speaker: "Speaker 1", text: "Recheck vitamin D" }],
};

it("AI_PROVIDER=alfred drafts next steps through Alfred on the fast tier, schema in the system text", async () => {
  env.AI_PROVIDER = "alfred";
  const generator = getNextStepGenerator();
  expect(generator).toBeInstanceOf(RelayNextStepGenerator);
  expect(generator?.modelId).toBe("alfred:fast");
  const { bodies } = useRelay("fast", [textTurn('{"nextSteps":[]}')]);
  expect(await generator?.generate(input)).toEqual({ nextSteps: [] });
  expect(bodies[0]).toMatchObject({
    feature: "aerwell.visit.next_steps",
    tier: "fast",
    maxTokens: 2048,
  });
  expect(String(bodies[0]?.["system"])).toContain(
    'Respond with JSON only matching this schema: {"type":"object"'
  );
  expect(bodies[0]).not.toHaveProperty("outputConfig");
  expect(JSON.stringify(bodies[0]?.["messages"])).toContain("Recheck vitamin D");
});

it("keeps only the relay error NAME and refuses malformed JSON", async () => {
  useRelay("fast", [429, textTurn("not json")]);
  const generator = new RelayNextStepGenerator();
  const error = await generator.generate(input).catch((e: unknown) => e);
  expect(error).toMatchObject({
    message: "suggestions_model_error",
    providerErrorName: "AI_RATE_LIMITED",
  });
  await expect(generator.generate(input)).rejects.toThrow("suggestions_malformed");
});
