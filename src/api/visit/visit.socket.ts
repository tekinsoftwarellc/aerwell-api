import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import {
  activeStaff,
  sessionIsLive,
  verifyAccessToken,
} from "../../common/middleware/authenticate.js";
import { logger } from "../../common/utils/logger.js";
import { Appointment } from "../appointment/appointment.model.js";
import { audit } from "../audit/audit.js";
import { LiveTranscription, providerErrorName } from "./liveTranscription.js";
import { MAX_CHUNK_BYTES, type TranscriptUpdate, getTranscriber } from "./transcribe.adapter.js";
import { onVisitSignal } from "./visit.events.js";
import { CaptureLease, TranscriptSegment } from "./visit.model.js";
import { LEASE_STALE_MS, activeConsent, orderedSegments, speakerNames } from "./visit.service.js";
import {
  type UpgradeContext,
  WS_PROTOCOL,
  authorizeUpgrade,
  authorizeVisit,
  refuseUpgrade,
} from "./visit.upgrade.js";

/**
 * `/ws/appointments/:id/transcription` — one socket = one capture stream.
 *
 *   client → {type:"start"}            server → {type:"started", captureIndex, startedAt}
 *   client → binary 16 kHz mono s16le PCM frames (≤ 32 000 bytes, even length)
 *   server → {type:"transcript", segmentId|null, speaker|null, text, isPartial, …}
 *   client → {type:"stop"}             server → {type:"stopped", segments} then close 1000
 *   client → {type:"reauth", token}    (a refreshed access token for the same staff member)
 *   server → {type:"error", code} then close 4xxx — machine codes only
 *
 * Final lines are saved before they are shown. Audio is never persisted: frames
 * pass through a bounded in-memory queue into Transcribe and are zero-filled.
 * NOTHING here logs transcript text, audio or member details.
 */
export interface VisitSocketOptions {
  heartbeatMs?: number;
  startTimeoutMs?: number;
  maxCaptureMs?: number;
  finishTimeoutMs?: number;
  maxPendingWrites?: number;
  maxBufferedBytes?: number;
}
const DEFAULTS: Required<VisitSocketOptions> = {
  heartbeatMs: 15_000,
  startTimeoutMs: 30_000,
  maxCaptureMs: 2 * 3_600_000,
  finishTimeoutMs: 30_000,
  maxPendingWrites: 100,
  maxBufferedBytes: 1_000_000,
};
const CLOSE_CODES: Record<string, number> = {
  SESSION_EXPIRED: 4401,
  SESSION_REVOKED: 4401,
  CONSENT_REQUIRED: 4403,
  CONSENT_REVOKED: 4403,
  ACCESS_REVOKED: 4403,
  CAPTURE_LEASE_LOST: 4409,
  CAPTURE_IN_PROGRESS: 4409,
  VISIT_NOT_IN_PROGRESS: 4410,
  VISIT_ENDED: 4410,
  TRANSCRIPTION_UNCONFIGURED: 4503,
  AUDIO_BACKLOG: 4429,
  CLIENT_BACKLOG: 4429,
  HEARTBEAT_TIMEOUT: 4408,
  BAD_MESSAGE: 4400,
  AUDIO_BEFORE_START: 4400,
  AUDIO_FRAME_INVALID: 4400,
  START_TIMEOUT: 4400,
  // RFC 6455 "service restart": the deploy drained this capture; lines shown are saved.
  SERVER_RESTARTING: 1012,
};
const message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }).strict(),
  z.object({ type: z.literal("stop") }).strict(),
  z.object({ type: z.literal("reauth"), token: z.string().min(1).max(4096) }).strict(),
]);

/** Returned by attachVisitSockets: drain every live capture (flush, save, close), then stop. */
export type CloseVisitSockets = (timeoutMs?: number) => Promise<void>;

export function attachVisitSockets(
  server: Server,
  options: VisitSocketOptions = {}
): CloseVisitSockets {
  const settings = { ...DEFAULTS, ...options };
  const connections = new Set<CaptureConnection>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CHUNK_BYTES + 4096,
    handleProtocols: (offered) => (offered.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });
  server.on("upgrade", (req, socket, head) => {
    // Node drops its own socket error listener before emitting "upgrade"; without
    // this, a client resetting mid-authorization is an uncaught exception.
    socket.on("error", () => socket.destroy());
    authorizeUpgrade(req).then(
      (context) =>
        wss.handleUpgrade(req, socket, head, (ws) => {
          const connection = new CaptureConnection(ws, context, settings);
          connections.add(connection);
          ws.on("close", () => connections.delete(connection));
          connection.open();
        }),
      (error: unknown) => refuseUpgrade(socket, error)
    );
  });
  return async (timeoutMs = 20_000) => {
    // Flush while Mongo is still connected: the caller disconnects only after this.
    await withTimeout(
      Promise.allSettled([...connections].map((c) => c.shutdown())),
      timeoutMs
    ).catch(() => undefined);
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
type Phase = "awaiting_start" | "starting" | "recording" | "stopping" | "done";
const codeOf = (error: unknown, fallback: string) =>
  error instanceof Error && /^[a-z0-9_]+$/i.test(error.message)
    ? error.message.toUpperCase()
    : fallback;

class CaptureConnection {
  #phase: Phase = "awaiting_start";
  #live: LiveTranscription | null = null;
  #captureId = randomUUID();
  #captureIndex = 0;
  #startedAt = new Date();
  #writes: Promise<void> = Promise.resolve();
  #stopping: Promise<void> = Promise.resolve();
  #pending = 0;
  #frames = 0;
  #segments = 0;
  #alive = true;
  #beating = false;
  #names = new Map<string, string>();
  #timers: NodeJS.Timeout[] = [];
  #unsubscribe: () => void = () => undefined;

  constructor(
    private readonly ws: WebSocket,
    private context: UpgradeContext,
    private readonly settings: Required<VisitSocketOptions>
  ) {}

  open() {
    const { ws, settings } = this;
    this.#unsubscribe = onVisitSignal((id, signal) => {
      if (id === this.context.appointmentId)
        this.fail(signal === "consent_revoked" ? "CONSENT_REVOKED" : "VISIT_ENDED");
    });
    ws.on("pong", () => {
      this.#alive = true;
    });
    ws.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
    ws.on("close", () => this.#onClose());
    ws.on("error", () => undefined);
    this.#timers.push(
      setTimeout(() => {
        if (this.#phase === "awaiting_start") this.fail("START_TIMEOUT");
      }, settings.startTimeoutMs),
      setInterval(() => this.#heartbeat(), settings.heartbeatMs)
    );
    this.#send({ type: "ready", appointmentId: this.context.appointmentId });
  }

  /** Fire-and-forget entry points: every failure path ends in fail(). */
  #onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.#onAudio(data as Buffer);
      return;
    }
    const parsed = message.safeParse(safeJson(String(data)));
    if (!parsed.success) this.fail("BAD_MESSAGE");
    else if (parsed.data.type === "start") {
      if (this.#phase === "awaiting_start")
        this.#start().catch((error: unknown) => this.fail(codeOf(error, "START_FAILED")));
    } else if (parsed.data.type === "stop") this.#stop();
    else this.#reauth(parsed.data.token);
  }

  async #start() {
    this.#phase = "starting";
    const { appointmentId } = this.context;
    const transcriber = getTranscriber();
    if (!transcriber) return this.fail("TRANSCRIPTION_UNCONFIGURED");
    const appointment = await Appointment.findById(appointmentId).select("status").lean();
    if (appointment?.status !== "in_progress") return this.fail("VISIT_NOT_IN_PROGRESS");
    if (!(await activeConsent(appointmentId))) return this.fail("CONSENT_REQUIRED");
    const lease = await claimLease(appointmentId, this.#captureId);
    if (!lease) return this.fail("CAPTURE_IN_PROGRESS");
    this.#captureIndex = lease.captureCount - 1;
    // A revocation (or a closed socket) while we awaited already ran fail().
    if (this.#phase !== "starting") return releaseLease(appointmentId, this.#captureId);
    const earlier = await orderedSegments(appointmentId);
    // …and again after this read: fail() has then already released the lease.
    if (this.#phase !== "starting") return;
    this.#names = speakerNames(earlier);
    this.#startedAt = new Date();
    this.#live = new LiveTranscription(transcriber, (update) => this.#onUpdate(update));
    this.#live.start();
    this.#live
      .failed()
      .catch((error: unknown) =>
        this.fail(codeOf(error, "TRANSCRIPTION_FAILED"), providerErrorName(error))
      );
    this.#phase = "recording";
    this.#timers.push(setTimeout(() => this.#stop(), this.settings.maxCaptureMs));
    await this.#audit("transcription_started");
    this.#send({
      type: "started",
      captureIndex: this.#captureIndex,
      startedAt: this.#startedAt.toISOString(),
    });
  }

  #audioRefusal(frame: Buffer): string | null {
    if (this.#phase === "awaiting_start" || this.#phase === "starting") return "AUDIO_BEFORE_START";
    if (frame.byteLength === 0 || frame.byteLength > MAX_CHUNK_BYTES || frame.byteLength % 2 !== 0)
      return "AUDIO_FRAME_INVALID";
    return this.#pending >= this.settings.maxPendingWrites ? "AUDIO_BACKLOG" : null;
  }

  #onAudio(frame: Buffer): void {
    if (this.#phase === "stopping" || this.#phase === "done") return;
    const refusal = this.#audioRefusal(frame);
    if (refusal || !this.#live) {
      this.fail(refusal ?? "AUDIO_BEFORE_START");
      return;
    }
    this.#pending += 1;
    this.#frames += 1;
    const live = this.#live;
    this.#writes = this.#writes
      .then(() => live.write(frame))
      .then(() => {
        this.#pending -= 1;
        frame.fill(0); // the queue holds its own copy; wipe the socket's buffer
      })
      .catch((error: unknown) => this.fail(codeOf(error, "AUDIO_WRITE_FAILED")));
  }

  async #onUpdate(update: TranscriptUpdate) {
    // After an abort (consent revoked, visit ended) nothing more is saved or shown.
    if (this.#phase !== "recording" && this.#phase !== "stopping") return;
    const key = `${this.#captureIndex}:${update.speakerLabel}`;
    let segmentId: string | null = null;
    if (!update.isPartial) {
      segmentId = await this.#save(update);
      if (!this.#names.has(key)) this.#names.set(key, `Speaker ${this.#names.size + 1}`);
    }
    this.#send({
      type: "transcript",
      resultId: update.resultId,
      segmentId,
      speaker: this.#names.get(key) ?? null,
      text: update.text,
      isPartial: update.isPartial,
      startedAtMs: update.startedAtMs,
      endedAtMs: update.endedAtMs,
      spokenAt: new Date(this.#startedAt.getTime() + update.startedAtMs).toISOString(),
    });
  }

  async #save(update: TranscriptUpdate) {
    const { appointmentId, memberId, organizationId } = this.context;
    try {
      const row = await TranscriptSegment.create({
        organizationId,
        appointmentId,
        memberId,
        captureIndex: this.#captureIndex,
        sourceSequence: update.sourceSequence,
        resultId: update.resultId,
        speakerLabel: update.speakerLabel,
        startedAtMs: update.startedAtMs,
        endedAtMs: update.endedAtMs,
        spokenAt: new Date(this.#startedAt.getTime() + update.startedAtMs),
        text: update.text,
        confidence: update.confidence,
      });
      this.#segments += 1;
      return String(row._id);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return null; // a repeated final
      throw error;
    }
  }

  /** Graceful server shutdown: a live capture flushes its last lines first. */
  async shutdown() {
    if (this.#phase === "recording") await this.#stop("SERVER_RESTARTING");
    // A stop the user already asked for finishes (and saves its tail) on its own.
    else if (this.#phase === "stopping") await this.#stopping;
    else await this.fail("SERVER_RESTARTING");
  }

  /** Flush and close; `reason` ends with that code instead of a user "stopped". */
  #stop(reason?: string): Promise<void> {
    if (this.#phase !== "recording" || !this.#live) return this.#stopping;
    this.#stopping = this.#finish(this.#live, reason);
    return this.#stopping;
  }

  async #finish(live: LiveTranscription, reason?: string) {
    this.#phase = "stopping";
    // A failure while we wait runs fail(), which moves the phase to done; every
    // step below re-checks it so a stop never writes over a failure.
    const stillStopping = () => this.#phase === "stopping";
    let finished = false;
    try {
      await this.#writes;
      if (!stillStopping()) return;
      await withTimeout(live.finish(), this.settings.finishTimeoutMs);
      if (!stillStopping()) return;
      this.#phase = "done";
      finished = true;
      await releaseLease(this.context.appointmentId, this.#captureId);
      await this.#audit("transcription_stopped");
      this.#log(reason ?? "stopped");
      if (reason) {
        this.#send({ type: "error", code: reason }, true);
        this.#close(CLOSE_CODES[reason] ?? 4500, reason);
        return;
      }
      this.#send({ type: "stopped", segments: this.#segments });
      this.#close(1000, "stopped");
    } catch (error) {
      // Once this stop owns "done" (a lease/audit write failed), fail() is a no-op: close here.
      if (finished) {
        logStoreFailure(error);
        this.#close(4500, "STOP_FAILED");
      } else await this.fail(codeOf(error, "TRANSCRIPTION_FAILED"), providerErrorName(error));
    }
  }

  /**
   * Every failure path ends here, and callers do not await it: whatever throws
   * inside, the client still gets the code and the socket still closes.
   */
  async fail(code: string, providerName?: string) {
    if (this.#phase === "done") return;
    const started = this.#phase === "recording" || this.#phase === "stopping";
    this.#phase = "done";
    try {
      // Not awaited: abort drops queued audio at once; a stalled provider must not hold the close.
      this.#live?.abort();
      await releaseLease(this.context.appointmentId, this.#captureId).catch(logStoreFailure);
      if (started) await this.#audit("transcription_interrupted").catch(logStoreFailure);
      this.#log(code, providerName);
    } catch (error) {
      logStoreFailure(error);
    } finally {
      this.#send({ type: "error", code }, true);
      this.#close(CLOSE_CODES[code] ?? 4500, code);
    }
  }

  async #heartbeat() {
    if (this.#beating || this.#phase === "done") return;
    if (!this.#alive) return this.fail("HEARTBEAT_TIMEOUT");
    this.#alive = false;
    this.ws.ping();
    this.#beating = true;
    try {
      const code = (await this.#revalidate()) ?? (await this.#renewLease());
      if (code) await this.fail(code);
    } catch {
      // Fail closed: if the database cannot confirm consent and access, capture stops.
      await this.fail("REVALIDATE_FAILED");
    } finally {
      this.#beating = false;
    }
  }

  async #renewLease(): Promise<string | null> {
    if (this.#phase !== "recording" && this.#phase !== "stopping") return null;
    const renewed = await CaptureLease.updateOne(
      { _id: this.context.appointmentId, captureId: this.#captureId },
      { $set: { heartbeatAt: new Date() } }
    );
    return renewed.matchedCount ? null : "CAPTURE_LEASE_LOST";
  }

  /** The HTTP checks again: expiry, logout/revocation, consent and visit status. */
  async #revalidate(): Promise<string | null> {
    const { access, appointmentId } = this.context;
    if (Date.now() >= access.expiresAtMs) return "SESSION_EXPIRED";
    const staff = await activeStaff(access.staff._id);
    if (!(staff && (await sessionIsLive(staff, access.sessionId, access.credentialVersion))))
      return "SESSION_REVOKED";
    // Role, override or assignment changes apply to an open socket too, as on HTTP.
    const allowed = await authorizeVisit(
      staff,
      appointmentId,
      this.context.actor.requestId ?? ""
    ).then(
      () => true,
      () => false
    );
    if (!allowed) return "ACCESS_REVOKED";
    if (this.#phase !== "recording") return null;
    if (!(await activeConsent(appointmentId))) return "CONSENT_REVOKED";
    const appointment = await Appointment.findById(appointmentId).select("status").lean();
    return appointment?.status === "in_progress" ? null : "VISIT_ENDED";
  }

  async #reauth(token: string) {
    try {
      const access = await verifyAccessToken(token);
      if (String(access.staff._id) !== String(this.context.access.staff._id))
        throw new Error("other staff");
      this.context = { ...this.context, access };
      this.#send({ type: "reauthed", expiresAt: new Date(access.expiresAtMs).toISOString() });
    } catch {
      await this.fail("SESSION_REVOKED");
    }
  }

  #onClose() {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#unsubscribe();
    // A closed tab mid-capture still flushes what Transcribe already heard.
    if (this.#phase === "recording") this.#stop();
    else if (this.#phase !== "done") this.fail("CONNECTION_CLOSED");
  }

  #send(payload: object, force = false) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (!force && this.ws.bufferedAmount > this.settings.maxBufferedBytes) {
      this.fail("CLIENT_BACKLOG");
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  #close(code: number, reason: string) {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#unsubscribe();
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(code, reason);
  }

  #audit(action: string) {
    const { actor, appointmentId, memberId } = this.context;
    return audit(actor, action, "VisitTranscript", appointmentId, memberId);
  }

  #log(outcome: string, providerName?: string) {
    try {
      this.#info(outcome, providerName);
    } catch (error) {
      logStoreFailure(error);
    }
  }

  #info(outcome: string, providerName?: string) {
    logger.info(
      {
        appointmentId: this.context.appointmentId,
        captureIndex: this.#captureIndex,
        outcome,
        frames: this.#frames,
        segments: this.#segments,
        ...(providerName ? { providerErrorName: providerName } : {}),
      },
      "Visit transcription ended"
    );
  }
}

async function claimLease(appointmentId: string, captureId: string) {
  try {
    return await CaptureLease.findOneAndUpdate(
      {
        _id: appointmentId,
        $or: [{ captureId: null }, { heartbeatAt: { $lt: new Date(Date.now() - LEASE_STALE_MS) } }],
      },
      { $set: { captureId, heartbeatAt: new Date() }, $inc: { captureCount: 1 } },
      { upsert: true, new: true }
    ).lean();
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return null; // held by a live capture
    throw error;
  }
}
async function releaseLease(appointmentId: string, captureId: string) {
  await CaptureLease.updateOne(
    { _id: appointmentId, captureId },
    { $set: { captureId: null, heartbeatAt: null } }
  );
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("transcription_finish_timeout")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
const logStoreFailure = (error: unknown) => {
  try {
    logger.error(
      { errorType: error instanceof Error ? error.name : "Unknown" },
      "Visit capture store update failed"
    );
  } catch {
    // A broken log sink must not turn a closed capture into an unhandled rejection.
  }
};
