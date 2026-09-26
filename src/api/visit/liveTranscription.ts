import type { StreamingTranscriber, TranscriptUpdate } from "./transcribe.adapter.js";

/**
 * One live, backpressured audio stream into a transcriber (port of the alfred-api
 * Session Notes `LiveTranscriptionSession`). Audio exists only in the bounded
 * in-memory queue while the provider is behind; delivered and dropped frames are
 * zero-filled, and nothing is ever written anywhere else.
 */
export class LiveTranscription {
  readonly #audio: BoundedAudioQueue;
  readonly #failure: Promise<never>;
  #reject!: (error: Error) => void;
  #processing: Promise<void> | null = null;
  #finishing = false;

  constructor(
    private readonly transcriber: StreamingTranscriber,
    private readonly onUpdate: (update: TranscriptUpdate) => Promise<void>,
    maximumBufferedBytes = 480_000 // 15 s of 16 kHz s16le
  ) {
    this.#audio = new BoundedAudioQueue(maximumBufferedBytes);
    this.#failure = new Promise<never>((_resolve, reject) => {
      this.#reject = reject;
    });
    this.#failure.catch(() => undefined);
  }

  start(): void {
    this.#processing = this.#consume().catch((error: unknown) => {
      const failure = normalizeFailure(error);
      this.#audio.fail(failure);
      this.#reject(failure);
      throw failure;
    });
    this.#processing.catch(() => undefined);
  }

  write(frame: Uint8Array): Promise<void> {
    if (!this.#processing || this.#finishing)
      return Promise.reject(new Error("transcription_closed"));
    return this.#audio.write(frame);
  }

  failed(): Promise<never> {
    return this.#failure;
  }

  /** Close the audio stream and wait for the provider's last results. */
  async finish(): Promise<void> {
    this.#finishing = true;
    this.#audio.close();
    await this.#processing;
  }

  /** Drop queued audio immediately (consent revoked, visit ended, failure). */
  async abort(): Promise<void> {
    this.#finishing = true;
    this.#audio.fail(new Error("transcription_aborted"));
    await this.#processing?.catch(() => undefined);
  }

  async #consume(): Promise<void> {
    for await (const update of this.transcriber.transcribe(this.#audio)) {
      await this.onUpdate(update);
    }
    if (!this.#finishing) throw new Error("transcription_ended_early");
  }
}

class BoundedAudioQueue implements AsyncIterable<Uint8Array> {
  readonly #chunks: Uint8Array[] = [];
  readonly #readers: Array<() => void> = [];
  readonly #writers: Array<() => void> = [];
  #buffered = 0;
  #closed = false;
  #failure: Error | null = null;

  constructor(private readonly maximumBytes: number) {}

  async write(frame: Uint8Array): Promise<void> {
    if (frame.byteLength > this.maximumBytes) throw new Error("audio_frame_invalid");
    while (this.#buffered + frame.byteLength > this.maximumBytes) {
      this.#assertWritable();
      await new Promise<void>((resolve) => this.#writers.push(resolve));
    }
    this.#assertWritable();
    this.#chunks.push(frame.slice());
    this.#buffered += frame.byteLength;
    wakeAll(this.#readers);
  }

  close(): void {
    this.#closed = true;
    wakeAll(this.#readers);
    wakeAll(this.#writers);
  }

  fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#closed = true;
    this.#destroy();
    wakeAll(this.#readers);
    wakeAll(this.#writers);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    let delivered: Uint8Array | null = null;
    try {
      while (true) {
        delivered?.fill(0);
        delivered = null;
        if (this.#failure) throw this.#failure;
        const chunk = this.#chunks.shift();
        if (chunk) {
          this.#buffered -= chunk.byteLength;
          wakeAll(this.#writers);
          delivered = chunk;
          yield chunk;
          continue;
        }
        if (this.#closed) return;
        await new Promise<void>((resolve) => this.#readers.push(resolve));
      }
    } finally {
      delivered?.fill(0);
      this.#destroy();
      wakeAll(this.#writers);
    }
  }

  #assertWritable(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new Error("transcription_closed");
  }

  #destroy(): void {
    for (const chunk of this.#chunks) chunk.fill(0);
    this.#chunks.length = 0;
    this.#buffered = 0;
  }
}

const wakeAll = (waiters: Array<() => void>) => {
  for (const wake of waiters.splice(0)) wake();
};

/** Machine codes pass through; a provider error keeps its NAME only (never its message). */
export function normalizeFailure(error: unknown): Error {
  if (error instanceof Error && /^[a-z0-9_]+$/.test(error.message)) return error;
  return Object.assign(new Error("transcription_failed"), {
    providerErrorName: error instanceof Error ? error.name : "UnknownError",
  });
}
export const providerErrorName = (error: unknown): string | undefined => {
  const name = (error as { providerErrorName?: unknown } | null)?.providerErrorName;
  return typeof name === "string" && /^[A-Za-z0-9_]{1,80}$/.test(name) ? name : undefined;
};
