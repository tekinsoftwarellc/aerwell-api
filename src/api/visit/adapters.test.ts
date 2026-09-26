import type { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { expect, it } from "vitest";
import { envSchema } from "../../config/env.js";
import { LiveTranscription, normalizeFailure } from "./liveTranscription.js";
import {
  BedrockNextStepGenerator,
  getNextStepGenerator,
  setNextStepGenerator,
} from "./suggestions.adapter.js";
import {
  AwsMedicalTranscriber,
  type MedicalStreamInput,
  type MedicalStreamResponse,
  getTranscriber,
  setTranscriber,
} from "./transcribe.adapter.js";

async function* chunks(...sizes: number[]) {
  for (const size of sizes) yield new Uint8Array(size);
}
async function collect<T>(source: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

it("calls the MEDICAL stream with speaker labels and maps results in first-seen order", async () => {
  let sent: MedicalStreamInput | undefined;
  const audioSeen: number[] = [];
  const client = {
    async send(command: unknown): Promise<MedicalStreamResponse> {
      sent = command as MedicalStreamInput;
      for await (const event of sent.AudioStream)
        audioSeen.push(event.AudioEvent.AudioChunk.byteLength);
      return {
        TranscriptResultStream: (async function* () {
          yield {
            TranscriptEvent: {
              Transcript: {
                Results: [
                  {
                    ResultId: "a",
                    IsPartial: true,
                    StartTime: 0.1,
                    EndTime: 0.5,
                    Alternatives: [
                      { Transcript: "Hel", Items: [{ Speaker: "spk_1", Confidence: 0.5 }] },
                    ],
                  },
                ],
              },
            },
          };
          yield {
            TranscriptEvent: {
              Transcript: {
                Results: [
                  {
                    ResultId: "b",
                    IsPartial: false,
                    StartTime: 1,
                    EndTime: 2,
                    Alternatives: [
                      {
                        Transcript: " Second ",
                        Items: [{ Confidence: 0.8 }, { Speaker: "spk_0", Confidence: 0.6 }],
                      },
                    ],
                  },
                ],
              },
            },
          };
          yield {
            TranscriptEvent: {
              Transcript: {
                Results: [
                  {
                    ResultId: "a",
                    IsPartial: false,
                    StartTime: 0.1,
                    EndTime: 0.9,
                    Alternatives: [{ Transcript: "Hello" }],
                  },
                  { ResultId: "c", Alternatives: [{ Transcript: "   " }] },
                ],
              },
            },
          };
        })(),
      };
    },
  };
  const transcriber = new AwsMedicalTranscriber(client, (input) => input);
  const updates = await collect(transcriber.transcribe(chunks(3200, 0, 3200)));
  expect(sent).toMatchObject({
    LanguageCode: "en-US",
    MediaEncoding: "pcm",
    MediaSampleRateHertz: 16000,
    Specialty: "PRIMARYCARE",
    Type: "CONVERSATION",
    ShowSpeakerLabel: true,
  });
  expect(audioSeen).toEqual([3200, 3200]); // empty chunks are skipped
  expect(updates).toEqual([
    {
      resultId: "a",
      sourceSequence: 0,
      speakerLabel: "spk_1",
      startedAtMs: 100,
      endedAtMs: 500,
      text: "Hel",
      confidence: 0.5,
      isPartial: true,
    },
    {
      resultId: "b",
      sourceSequence: 1,
      speakerLabel: "spk_0",
      startedAtMs: 1000,
      endedAtMs: 2000,
      text: "Second",
      confidence: 0.7,
      isPartial: false,
    },
    {
      resultId: "a",
      sourceSequence: 0,
      speakerLabel: "spk_0",
      startedAtMs: 100,
      endedAtMs: 900,
      text: "Hello",
      confidence: null,
      isPartial: false,
    },
  ]);
});

it("refuses odd-length audio and a missing result stream", async () => {
  const drain = {
    async send(command: unknown): Promise<MedicalStreamResponse> {
      for await (const event of (command as MedicalStreamInput).AudioStream) event.AudioEvent;
      return {};
    },
  };
  const t = new AwsMedicalTranscriber(drain, (input) => input);
  await expect(collect(t.transcribe(chunks(3201)))).rejects.toThrow("audio_frame_invalid");
  await expect(collect(t.transcribe(chunks(3200)))).rejects.toThrow(
    "transcription_no_result_stream"
  );
});

it("keeps provider error NAMES only and passes machine codes through", () => {
  const provider = Object.assign(new Error("arn:aws:iam::1:user/x denied"), {
    name: "AccessDeniedException",
  });
  const normalized = normalizeFailure(provider);
  expect(normalized.message).toBe("transcription_failed");
  expect((normalized as { providerErrorName?: string }).providerErrorName).toBe(
    "AccessDeniedException"
  );
  expect(normalizeFailure(new Error("audio_frame_invalid")).message).toBe("audio_frame_invalid");
  expect(normalizeFailure("weird").message).toBe("transcription_failed");
});

it("a live transcription that ends before finish is a failure", async () => {
  const early = new LiveTranscription({ async *transcribe() {} }, async () => undefined);
  early.start();
  await expect(early.failed()).rejects.toThrow("transcription_ended_early");
  await expect(early.write(new Uint8Array(2))).rejects.toThrow();
});

it("Bedrock requests structured output on the configured model and hides provider text", async () => {
  let command: ConverseCommand | undefined;
  const ok = new BedrockNextStepGenerator(
    {
      send: async (c) => {
        command = c;
        return { output: { message: { content: [{ text: '{"nextSteps":[]}' }] } } };
      },
    },
    "us.anthropic.claude-haiku-4-5"
  );
  expect(await ok.generate({ visitReason: null, serviceTitle: "Visit", segments: [] })).toEqual({
    nextSteps: [],
  });
  expect(command?.input).toMatchObject({
    modelId: "us.anthropic.claude-haiku-4-5",
    inferenceConfig: { temperature: 0 },
    outputConfig: { textFormat: { type: "json_schema" } },
  });
  const denied = new BedrockNextStepGenerator(
    {
      send: async () => {
        throw Object.assign(new Error("User arn:aws:iam::1 is not authorized"), {
          name: "AccessDeniedException",
        });
      },
    },
    "us.x"
  );
  const error = await denied
    .generate({ visitReason: null, serviceTitle: null, segments: [] })
    .catch((e: Error) => e);
  expect((error as Error).message).toBe("suggestions_model_error");
  expect((error as { providerErrorName?: string }).providerErrorName).toBe("AccessDeniedException");
  const reply = (text?: string) =>
    new BedrockNextStepGenerator(
      { send: async () => ({ output: { message: { content: [{ text }] } } }) },
      "us.x"
    );
  await expect(
    reply("not json").generate({ visitReason: null, serviceTitle: null, segments: [] })
  ).rejects.toThrow("suggestions_malformed");
  await expect(
    reply(undefined).generate({ visitReason: null, serviceTitle: null, segments: [] })
  ).rejects.toThrow("suggestions_empty");
});

it("stays unconfigured without region and model, and accepts only us. inference profiles", () => {
  setTranscriber(undefined);
  setNextStepGenerator(undefined);
  expect(getTranscriber()).toBeNull();
  expect(getNextStepGenerator()).toBeNull();
  const base = { MONGODB_URI: "mongodb://127.0.0.1/test" };
  expect(
    envSchema.safeParse({ ...base, BEDROCK_MODEL_FAST: "anthropic.claude-haiku-4-5" }).success
  ).toBe(false);
  expect(
    envSchema.safeParse({ ...base, BEDROCK_MODEL_SMART: "eu.anthropic.claude-sonnet-5" }).success
  ).toBe(false);
  expect(
    envSchema.safeParse({ ...base, BEDROCK_MODEL_FAST: "us.anthropic.claude-haiku-4-5" }).success
  ).toBe(true);
});
