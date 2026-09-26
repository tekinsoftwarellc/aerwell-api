import { type Server, createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import WebSocket from "ws";
import type { StreamingTranscriber, TranscriptUpdate } from "../api/visit/transcribe.adapter.js";
import { CONSENT_TEXT } from "../api/visit/visit.model.js";
import { type VisitSocketOptions, attachVisitSockets } from "../api/visit/visit.socket.js";
import { bookingWorld } from "./appointmentFixture.js";
import { app } from "./scheduleFixture.js";

export const final = (
  n: number,
  speakerLabel: string,
  text: string,
  extra: Partial<TranscriptUpdate> = {}
): TranscriptUpdate => ({
  resultId: `r${n}`,
  sourceSequence: n,
  speakerLabel,
  startedAtMs: n * 1000,
  endedAtMs: n * 1000 + 900,
  text,
  confidence: 0.9,
  isPartial: false,
  ...extra,
});

/**
 * Strict fake Transcribe: mirrors the provider rules that kill a real stream
 * (odd-length or oversized PCM chunks) and keeps byte COUNTS only, never audio.
 * `script[i]` is emitted after the i-th chunk; `tail` after the stream closes.
 */
export class FakeTranscriber implements StreamingTranscriber {
  streams = 0;
  chunks = 0;
  bytes = 0;
  constructor(
    private readonly script: TranscriptUpdate[][] = [],
    private readonly tail: TranscriptUpdate[] = [],
    private readonly failure?: { afterChunks: number; error: Error },
    private readonly hold?: Promise<void>
  ) {}
  /** Results the "provider" still delivers after our audio stream was aborted. */
  late: TranscriptUpdate[] = [];
  async *transcribe(audio: AsyncIterable<Uint8Array>): AsyncIterable<TranscriptUpdate> {
    this.streams += 1;
    try {
      for await (const chunk of audio) yield* await this.#consume(chunk);
    } catch (error) {
      yield* this.late;
      throw error;
    }
    yield* this.tail;
  }
  async #consume(chunk: Uint8Array): Promise<TranscriptUpdate[]> {
    if (chunk.byteLength % 2 !== 0 || chunk.byteLength > 32_000)
      throw Object.assign(new Error("Bad chunk"), { name: "BadRequestException" });
    if (this.hold) await this.hold;
    const index = this.chunks;
    this.chunks += 1;
    this.bytes += chunk.byteLength;
    if (this.failure && this.chunks >= this.failure.afterChunks) throw this.failure.error;
    return this.script[index] ?? [];
  }
}

/** A booked, checked-in, STARTED visit plus the actors the tests need. */
export async function visitWorld(start = true) {
  const w = await bookingWorld();
  const member = await w.member(["aerwell-essential"]);
  const res = await w.api.post(
    "/api/v1/appointments",
    w.booking(member._id, "clinician-telehealth-visit")
  );
  expect(res.status).toBe(201);
  const id = res.body.data.appointment._id as string;
  const status = (s: string) => w.api.patch(`/api/v1/appointments/${id}/status`, { status: s });
  if (start) {
    expect((await status("checked_in")).status).toBe(200);
    expect((await status("in_progress")).status).toBe(200);
  }
  const consent = () =>
    w.api.post(`/api/v1/appointments/${id}/visit/consent`, {
      method: "verbal",
      consentVersion: CONSENT_TEXT.version,
    });
  return { ...w, memberRow: member, id, status, consent };
}

export async function socketServer(options: VisitSocketOptions = {}) {
  const server: Server = createHttpServer(app);
  const detach = attachVisitSockets(server, options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      detach();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface Received {
  type: string;
  code?: string;
  segments?: number;
  isPartial?: boolean;
  speaker?: string | null;
  text?: string;
  segmentId?: string | null;
  [key: string]: unknown;
}
/** A WebSocket client that records every JSON message and the close frame. */
export function connect(
  port: number,
  appointmentId: string,
  token: string | null,
  options: WebSocket.ClientOptions = {}
) {
  const protocols = token ? ["aerwell.v1", `bearer.${token}`] : ["aerwell.v1"];
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/appointments/${appointmentId}/transcription`,
    protocols,
    options
  );
  const messages: Received[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (data, isBinary) => {
    if (!isBinary) messages.push(JSON.parse(String(data)) as Received);
    for (const wake of waiters.splice(0)) wake();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on("close", (code, reason) => resolve({ code, reason: String(reason) }))
  );
  const refused = new Promise<number>((resolve) =>
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0))
  );
  ws.on("error", () => undefined);
  // performance.now, not Date: the tests pin Date.
  async function next(type: string, timeoutMs = 5_000): Promise<Received> {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const found = messages.find((m) => m.type === type);
      if (found) return found;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    throw new Error(`No ${type} message; got ${messages.map((m) => m.type).join(",")}`);
  }
  const opened = new Promise<void>((resolve) => ws.on("open", () => resolve()));
  const send = (payload: object) => ws.send(JSON.stringify(payload));
  return { ws, messages, next, closed, refused, opened, send };
}

/** One 100 ms frame of synthetic PCM with a recognisable byte pattern. */
export const pcmFrame = (fill = 0x5a, bytes = 3200) => Buffer.alloc(bytes, fill);
export const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
