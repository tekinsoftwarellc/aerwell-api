import {
  StartMedicalStreamTranscriptionCommand,
  type StartMedicalStreamTranscriptionCommandInput,
  TranscribeStreamingClient,
} from "@aws-sdk/client-transcribe-streaming";
import { env } from "../../config/env.js";

/**
 * Amazon Transcribe Medical streaming (AWS only, BAA). Ported from the alfred-api
 * Session Notes adapter (`sessionNotes/transcribe/transcribeStreaming.ts`), which
 * is the one AWS-native pipeline already exercised against real Transcribe; this
 * one calls the MEDICAL stream (specialty + conversation type) instead.
 *
 * Audio is 16 kHz mono signed 16-bit little-endian PCM. Nothing here stores audio.
 */
export const SAMPLE_RATE = 16_000;
export const MAX_CHUNK_BYTES = 32_000;

export interface TranscriptUpdate {
  resultId: string;
  /** Order of first appearance of this result within ONE stream. */
  sourceSequence: number;
  /** Raw diarization label ("spk_0"); never a role or a name. */
  speakerLabel: string;
  startedAtMs: number;
  endedAtMs: number;
  text: string;
  confidence: number | null;
  isPartial: boolean;
}

export interface StreamingTranscriber {
  transcribe(audio: AsyncIterable<Uint8Array>): AsyncIterable<TranscriptUpdate>;
}

interface MedicalResult {
  ResultId?: string;
  IsPartial?: boolean;
  StartTime?: number;
  EndTime?: number;
  Alternatives?: readonly {
    Transcript?: string;
    Items?: readonly { Speaker?: string; Confidence?: number }[];
  }[];
}
export interface MedicalStreamResponse {
  TranscriptResultStream?: AsyncIterable<{
    TranscriptEvent?: { Transcript?: { Results?: readonly MedicalResult[] } };
  }>;
}
export interface MedicalClientLike {
  send(command: unknown): Promise<MedicalStreamResponse>;
}
export type MedicalStreamInput = {
  LanguageCode: "en-US";
  MediaEncoding: "pcm";
  MediaSampleRateHertz: typeof SAMPLE_RATE;
  Specialty: "PRIMARYCARE";
  Type: "CONVERSATION";
  ShowSpeakerLabel: true;
  AudioStream: AsyncIterable<{ AudioEvent: { AudioChunk: Uint8Array } }>;
};

export class AwsMedicalTranscriber implements StreamingTranscriber {
  constructor(
    private readonly client: MedicalClientLike,
    private readonly command: (input: MedicalStreamInput) => unknown
  ) {}

  async *transcribe(audio: AsyncIterable<Uint8Array>): AsyncIterable<TranscriptUpdate> {
    const response = await this.client.send(
      this.command({
        LanguageCode: "en-US",
        MediaEncoding: "pcm",
        MediaSampleRateHertz: SAMPLE_RATE,
        Specialty: "PRIMARYCARE",
        Type: "CONVERSATION",
        ShowSpeakerLabel: true,
        AudioStream: audioEvents(audio),
      })
    );
    if (!response.TranscriptResultStream) throw new Error("transcription_no_result_stream");
    const sequence = new Map<string, number>();
    for await (const event of response.TranscriptResultStream) {
      for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
        const update = toUpdate(result, sequence);
        if (update) yield update;
      }
    }
  }
}

function toUpdate(result: MedicalResult, sequence: Map<string, number>): TranscriptUpdate | null {
  const alternative = result.Alternatives?.[0];
  const text = alternative?.Transcript?.trim();
  if (!(result.ResultId && alternative && text)) return null;
  if (!sequence.has(result.ResultId)) sequence.set(result.ResultId, sequence.size);
  const confidences = (alternative.Items ?? [])
    .map((item) => item.Confidence)
    .filter((value): value is number => value !== undefined);
  return {
    resultId: result.ResultId,
    sourceSequence: sequence.get(result.ResultId) ?? 0,
    speakerLabel: alternative.Items?.find((item) => item.Speaker)?.Speaker ?? "spk_0",
    startedAtMs: toMs(result.StartTime),
    endedAtMs: toMs(result.EndTime),
    text,
    confidence: confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : null,
    isPartial: result.IsPartial ?? true,
  };
}

async function* audioEvents(source: AsyncIterable<Uint8Array>) {
  for await (const chunk of source) {
    if (chunk.byteLength === 0) continue;
    if (chunk.byteLength > MAX_CHUNK_BYTES || chunk.byteLength % 2 !== 0)
      throw new Error("audio_frame_invalid");
    yield { AudioEvent: { AudioChunk: chunk } };
  }
}

const toMs = (seconds: number | undefined) => Math.max(0, Math.round((seconds ?? 0) * 1000));

let override: StreamingTranscriber | null | undefined;
let real: StreamingTranscriber | undefined;

/** The configured transcriber, or null (TRANSCRIPTION_UNCONFIGURED) without TRANSCRIBE_REGION. */
export function getTranscriber(): StreamingTranscriber | null {
  if (override !== undefined) return override;
  if (!env.TRANSCRIBE_REGION) return null;
  // Credentials come from the SDK default chain (the box's IAM principal).
  real ??= new AwsMedicalTranscriber(
    new TranscribeStreamingClient({ region: env.TRANSCRIBE_REGION }),
    (input) =>
      new StartMedicalStreamTranscriptionCommand(
        input as StartMedicalStreamTranscriptionCommandInput
      )
  );
  return real;
}
/** Tests only: a fake, `null` for unconfigured, `undefined` to restore env wiring. */
export function setTranscriber(next: StreamingTranscriber | null | undefined) {
  override = next;
}
