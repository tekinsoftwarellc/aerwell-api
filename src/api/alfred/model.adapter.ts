import {
  BedrockRuntimeClient,
  type ContentBlock,
  ConverseCommand,
  type ConverseCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import { AppError } from "../../common/errors/AppError.js";
import { env } from "../../config/env.js";

/**
 * Alfred AI's model seam: Amazon Bedrock Converse only (AWS, BAA), through the
 * `us.` inference profiles in BEDROCK_MODEL_FAST / BEDROCK_MODEL_SMART (the env
 * schema refuses any other id). Chat with tools runs on SMART; structured
 * suggestions run on FAST (Sonnet 5 rejected Converse `outputConfig` on 2026-09-25;
 * Sonnet 5.5 accepts it, 2026-10-09). Sonnet 5.x and Haiku 5.5 reject `temperature`,
 * so no request sets it. Tests replace the model with a scripted fake.
 */
export type AlfredTier = "fast" | "smart";
export type ConverseRequest = Omit<ConverseCommandInput, "modelId">;
export interface ModelTurn {
  stopReason: string;
  content: ContentBlock[];
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}
export interface AlfredModel {
  readonly modelId: string;
  converse(request: ConverseRequest): Promise<ModelTurn>;
}
interface ConverseClient {
  send(command: ConverseCommand): Promise<{
    stopReason?: string;
    output?: { message?: { content?: ContentBlock[] } };
    usage?: { inputTokens?: number; outputTokens?: number };
    metrics?: { latencyMs?: number };
  }>;
}

/** Provider text can carry request details: keep the error NAME only. */
export class ModelCallError extends Error {
  constructor(readonly providerErrorName: string) {
    super("alfred_model_error");
  }
}

export class BedrockAlfredModel implements AlfredModel {
  constructor(
    private readonly client: ConverseClient,
    readonly modelId: string
  ) {}

  async converse(request: ConverseRequest): Promise<ModelTurn> {
    const started = Date.now();
    try {
      const response = await this.client.send(
        new ConverseCommand({ ...request, modelId: this.modelId })
      );
      return {
        stopReason: response.stopReason ?? "end_turn",
        content: response.output?.message?.content ?? [],
        usage: {
          inputTokens: response.usage?.inputTokens ?? 0,
          outputTokens: response.usage?.outputTokens ?? 0,
        },
        latencyMs: response.metrics?.latencyMs ?? Date.now() - started,
      };
    } catch (error) {
      throw new ModelCallError(error instanceof Error ? error.name : "UnknownError");
    }
  }
}

export const aiUnconfigured = () =>
  new AppError(
    "Alfred AI is not configured for this clinic yet",
    503,
    true,
    undefined,
    "AI_UNCONFIGURED"
  );

const overrides = new Map<AlfredTier, AlfredModel | null>();
const real = new Map<AlfredTier, AlfredModel>();
let client: BedrockRuntimeClient | undefined;

/** The configured model for a tier, or null when AI is unconfigured. */
export function getAlfredModel(tier: AlfredTier): AlfredModel | null {
  if (overrides.has(tier)) return overrides.get(tier) ?? null;
  const modelId = tier === "smart" ? env.BEDROCK_MODEL_SMART : env.BEDROCK_MODEL_FAST;
  if (!(env.BEDROCK_REGION && modelId)) return null;
  const cached = real.get(tier);
  if (cached) return cached;
  client ??= new BedrockRuntimeClient({ region: env.BEDROCK_REGION, maxAttempts: 3 });
  const created = new BedrockAlfredModel(client, modelId);
  real.set(tier, created);
  return created;
}
/** Tests only: a fake, `null` for unconfigured, `undefined` to restore env wiring. */
export function setAlfredModel(tier: AlfredTier, next: AlfredModel | null | undefined) {
  if (next === undefined) overrides.delete(tier);
  else overrides.set(tier, next);
}
