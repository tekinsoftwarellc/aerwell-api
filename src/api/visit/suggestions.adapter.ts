import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import { env } from "../../config/env.js";
import { ACTION_TYPES } from "./visit.model.js";

/**
 * Next-step drafts from Amazon Bedrock (AWS only, `us.` inference profiles; the env
 * schema refuses any other model id). Ported from the alfred-api Session Notes
 * report generator. Recorded real-AWS facts from that work (2026-09-25):
 * Sonnet 5 rejects the Converse `outputConfig` structured-output field, so this
 * runs on BEDROCK_MODEL_FAST; the model invents identifiers, so the server assigns
 * every id; one bad item must be dropped, not the whole result.
 */
export const PROMPT_VERSION = "visit-next-steps-v1";

const SYSTEM_PROMPT = [
  "You draft follow-up next steps for a clinician after a recorded clinic visit, using only the supplied transcript segments.",
  "Speakers are labelled Speaker 1, Speaker 2 and so on. Do not guess who is the clinician or the member, and never invent names.",
  "Each next step needs a short title, a one or two sentence detail, an actionType (order, add, book, review or follow_up) and the segmentId values that support it.",
  "Only suggest steps grounded in what was said. Never add diagnoses, doses, dates or facts that were not said. Return an empty list when nothing applies.",
  "These are drafts: a clinician accepts, edits or rejects each one.",
].join(" ");

export const nextStepsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nextSteps"],
  properties: {
    nextSteps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "actionType", "evidenceSegmentIds"],
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          actionType: { type: "string", enum: [...ACTION_TYPES] },
          evidenceSegmentIds: { type: "array", minItems: 1, items: { type: "string" } },
        },
      },
    },
  },
} as const;

export interface NextStepInput {
  visitReason: string | null;
  serviceTitle: string | null;
  segments: { segmentId: string; speaker: string; text: string }[];
}
export interface NextStepGenerator {
  readonly modelId: string;
  /** The model's raw JSON body; the caller validates it item by item. */
  generate(input: NextStepInput): Promise<unknown>;
}
export interface ConverseClientLike {
  send(command: ConverseCommand): Promise<{
    output?: { message?: { content?: ReadonlyArray<{ text?: string }> } };
  }>;
}

export class BedrockNextStepGenerator implements NextStepGenerator {
  constructor(
    private readonly client: ConverseClientLike,
    readonly modelId: string
  ) {}

  async generate(input: NextStepInput): Promise<unknown> {
    let response: Awaited<ReturnType<ConverseClientLike["send"]>>;
    try {
      response = await this.client.send(new ConverseCommand(nextStepsRequest(this.modelId, input)));
    } catch (error) {
      // Provider text can carry request details: keep the error NAME only.
      throw Object.assign(new Error("suggestions_model_error"), {
        providerErrorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    const text = response.output?.message?.content?.find((block) => block.text)?.text;
    if (!text) throw new Error("suggestions_empty");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("suggestions_malformed");
    }
  }
}

export function nextStepsRequest(modelId: string, input: NextStepInput): ConverseCommandInput {
  return {
    modelId,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [{ role: "user", content: [{ text: JSON.stringify(input) }] }],
    inferenceConfig: { maxTokens: 2_048 },
    outputConfig: {
      textFormat: {
        type: "json_schema",
        structure: {
          jsonSchema: {
            name: "visit_next_steps_v1",
            description: "Draft next steps for clinician review",
            schema: JSON.stringify(nextStepsJsonSchema),
          },
        },
      },
    },
  };
}

let override: NextStepGenerator | null | undefined;
let real: NextStepGenerator | undefined;

/** The configured generator, or null (SUGGESTIONS_UNCONFIGURED). */
export function getNextStepGenerator(): NextStepGenerator | null {
  if (override !== undefined) return override;
  if (!(env.BEDROCK_REGION && env.BEDROCK_MODEL_FAST)) return null;
  real ??= new BedrockNextStepGenerator(
    new BedrockRuntimeClient({ region: env.BEDROCK_REGION, maxAttempts: 3 }),
    env.BEDROCK_MODEL_FAST
  );
  return real;
}
/** Tests only: a fake, `null` for unconfigured, `undefined` to restore env wiring. */
export function setNextStepGenerator(next: NextStepGenerator | null | undefined) {
  override = next;
}
