import mongoose from "mongoose";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pinClock } from "../../test/appointmentFixture.js";
import { as } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import {
  FakeTranscriber,
  connect,
  final,
  pcmFrame,
  settle,
  socketServer,
  visitWorld,
} from "../../test/visitFixture.js";
import { Appointment } from "../appointment/appointment.model.js";
import { AuditEvent } from "../audit/audit.js";
import { issueSession, revokeStaffSessions } from "../auth/session.service.js";
import { Member } from "../member/member.model.js";
import { setTranscriber } from "./transcribe.adapter.js";
import { emitVisitSignal } from "./visit.events.js";
import { CaptureLease, TranscriptSegment, VisitConsent } from "./visit.model.js";

let server: Awaited<ReturnType<typeof socketServer>>;
beforeEach(async () => {
  pinClock();
  server = await socketServer({ heartbeatMs: 150, startTimeoutMs: 2_000 });
});
afterEach(async () => {
  await server.close();
  setTranscriber(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const partial = (n: number, text: string) => ({ ...final(n, "spk_0", text), isPartial: true });

async function recording(transcriber: FakeTranscriber, token?: string) {
  const v = await visitWorld();
  setTranscriber(transcriber);
  expect((await v.consent()).status).toBe(201);
  const client = connect(server.port, v.id, token ?? v.director.accessToken);
  await client.next("ready");
  client.send({ type: "start" });
  await client.next("started");
  return { v, client };
}

it("refuses the upgrade without a valid token, clinical access, scope or allowed origin", async () => {
  const v = await visitWorld();
  const refusedWith = (token: string | null, id = v.id, headers: Record<string, string> = {}) =>
    connect(server.port, id, token, { headers }).refused;
  expect(await refusedWith(null)).toBe(401);
  expect(await refusedWith("not-a-jwt")).toBe(401);
  const frontDesk = await staffFixture(false, 4); // APPOINTMENTS edit, no CLINICAL_NOTES
  expect(await refusedWith(frontDesk.accessToken)).toBe(403);
  const coordinator = await staffFixture(false, 3); // CLINICAL_NOTES view only
  expect(await refusedWith(coordinator.accessToken)).toBe(403);
  expect(await refusedWith(v.director.accessToken, "0123456789abcdef01234567")).toBe(404);
  expect(await refusedWith(v.director.accessToken, v.id, { origin: "https://evil.example" })).toBe(
    403
  );
  await revokeStaffSessions(String(v.director.staff._id));
  expect(await refusedWith(v.director.accessToken)).toBe(401);
});

it("requires recorded consent before any audio is captured", async () => {
  const v = await visitWorld();
  const fake = new FakeTranscriber();
  setTranscriber(fake);
  const client = connect(server.port, v.id, v.director.accessToken);
  await client.next("ready");
  client.send({ type: "start" });
  expect((await client.next("error")).code).toBe("CONSENT_REQUIRED");
  expect((await client.closed).code).toBe(4403);
  expect(fake.streams).toBe(0);
  expect(await CaptureLease.countDocuments({ captureId: { $ne: null } })).toBe(0);
});

it("reports TRANSCRIPTION_UNCONFIGURED when Transcribe is not configured", async () => {
  const v = await visitWorld();
  setTranscriber(null);
  await v.consent();
  const client = connect(server.port, v.id, v.director.accessToken);
  await client.next("ready");
  client.send({ type: "start" });
  expect((await client.next("error")).code).toBe("TRANSCRIPTION_UNCONFIGURED");
  expect((await client.closed).code).toBe(4503);
});

it("streams live lines, saves finals in order, stores no audio, and audits the capture", async () => {
  const fake = new FakeTranscriber(
    [
      [partial(0, "Good morn")],
      [final(0, "spk_0", "Good morning.")],
      [final(1, "spk_1", "Hi there.")],
    ],
    [final(2, "spk_0", "Let's review your labs.")]
  );
  const { v, client } = await recording(fake);
  for (let i = 0; i < 3; i += 1) client.ws.send(pcmFrame(0x5a));
  const stopped = client.next("stopped");
  await client.next("transcript");
  await settle(100);
  client.send({ type: "stop" });
  expect((await stopped).segments).toBe(3);
  expect((await client.closed).code).toBe(1000);

  const lines = client.messages.filter((m) => m.type === "transcript");
  expect(lines[0]).toMatchObject({ isPartial: true, segmentId: null, text: "Good morn" });
  expect(lines.filter((l) => !l.isPartial).map((l) => `${l.speaker}:${l.text}`)).toEqual([
    "Speaker 1:Good morning.",
    "Speaker 2:Hi there.",
    "Speaker 1:Let's review your labs.",
  ]);
  // Every segmentId the client saw is already persisted.
  const saved = await TranscriptSegment.find({ appointmentId: v.id })
    .sort({ sourceSequence: 1 })
    .lean();
  expect(lines.filter((l) => !l.isPartial).map((l) => l.segmentId)).toEqual(
    saved.map((s) => String(s._id))
  );
  expect(fake.bytes).toBe(9600);

  const transcript = await v.api.get(`/api/v1/appointments/${v.id}/transcript`);
  expect(transcript.body.data.segments.map((s: { speaker: string }) => s.speaker)).toEqual([
    "Speaker 1",
    "Speaker 2",
    "Speaker 1",
  ]);
  await expectNoAudioStored(0x5a);
  expect(await CaptureLease.findById(v.id).lean()).toMatchObject({
    captureId: null,
    captureCount: 1,
  });
  const trail = await AuditEvent.find({ targetType: "VisitTranscript" }).sort({ _id: 1 }).lean();
  expect(trail.map((e) => e.action)).toEqual([
    "transcription_started",
    "transcription_stopped",
    "viewed",
  ]);
  expect(trail[0]).toMatchObject({
    actorId: String(v.director.staff._id),
    memberId: String(v.memberRow._id),
  });
});

/** No document anywhere holds binary data or the synthetic audio bytes. */
async function expectNoAudioStored(fill: number) {
  const marker = Buffer.alloc(64, fill).toString("base64");
  for (const collection of (await mongoose.connection.db?.collections()) ?? []) {
    const docs = await collection.find({}).toArray();
    const json = JSON.stringify(docs, (_key, value) =>
      value?._bsontype === "Binary" ? "__BINARY__" : value
    );
    expect(json, collection.collectionName).not.toContain("__BINARY__");
    expect(json, collection.collectionName).not.toContain(marker);
  }
}

it("revoking consent stops capture at once: later audio never reaches Transcribe or the record", async () => {
  const fake = new FakeTranscriber([
    [final(0, "spk_0", "Before.")],
    [],
    [],
    [final(3, "spk_0", "After.")],
  ]);
  fake.late = [final(9, "spk_0", "Late result after the abort.")];
  // A long heartbeat: only the immediate in-process signal can stop this capture in time.
  await server.close();
  server = await socketServer({ heartbeatMs: 60_000 });
  const { v, client } = await recording(fake);
  client.ws.send(pcmFrame());
  await client.next("transcript");
  const create = vi.spyOn(TranscriptSegment, "create");
  expect((await v.api.post(`/api/v1/appointments/${v.id}/visit/consent/revoke`)).status).toBe(200);
  expect((await client.next("error")).code).toBe("CONSENT_REVOKED");
  const bytesAtRevoke = fake.bytes;
  for (let i = 0; i < 3; i += 1) client.ws.readyState === 1 && client.ws.send(pcmFrame());
  expect((await client.closed).code).toBe(4403);
  await settle(200);
  expect(fake.bytes).toBe(bytesAtRevoke);
  expect(create).not.toHaveBeenCalled();
  expect((await TranscriptSegment.find({ appointmentId: v.id }).lean()).map((s) => s.text)).toEqual(
    ["Before."]
  );
  expect(await CaptureLease.countDocuments({ captureId: { $ne: null } })).toBe(0);
});

it("completing the visit ends a live capture at once", async () => {
  await server.close();
  server = await socketServer({ heartbeatMs: 60_000 });
  const { v, client } = await recording(new FakeTranscriber());
  expect((await v.status("completed")).status).toBe(200);
  expect((await client.next("error")).code).toBe("VISIT_ENDED");
  expect((await client.closed).code).toBe(4410);
});

it("a consent revoked without the in-process signal (another API instance) is caught on the next heartbeat", async () => {
  const { v, client } = await recording(new FakeTranscriber());
  await VisitConsent.updateOne(
    { appointmentId: v.id, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  expect((await client.next("error")).code).toBe("CONSENT_REVOKED");
  expect((await client.closed).code).toBe(4403);
});

it("a visit ended elsewhere is caught on the next heartbeat", async () => {
  const { v, client } = await recording(new FakeTranscriber());
  await Appointment.updateOne({ _id: v.id }, { $set: { status: "completed" } });
  expect((await client.next("error")).code).toBe("VISIT_ENDED");
});

it("logout closes the socket on the next heartbeat", async () => {
  const { v, client } = await recording(new FakeTranscriber());
  await revokeStaffSessions(String(v.director.staff._id));
  expect((await client.next("error")).code).toBe("SESSION_REVOKED");
  expect((await client.closed).code).toBe(4401);
});

it("closes when the access token expires unless the client re-authenticates", async () => {
  const { v, client } = await recording(new FakeTranscriber());
  vi.setSystemTime(new Date("2027-03-01T20:10:00.000Z"));
  const fresh = await issueSession(String(v.director.staff._id), 0);
  client.send({ type: "reauth", token: fresh.accessToken });
  await client.next("reauthed");
  vi.setSystemTime(new Date("2027-03-01T20:20:00.000Z")); // first token expired, fresh one still valid
  await settle(400);
  expect(client.ws.readyState).toBe(1);
  vi.setSystemTime(new Date("2027-03-01T20:26:00.000Z"));
  expect((await client.next("error")).code).toBe("SESSION_EXPIRED");
});

it("refuses a re-auth token that belongs to someone else", async () => {
  const { client } = await recording(new FakeTranscriber());
  const other = await staffFixture();
  client.send({ type: "reauth", token: other.accessToken });
  expect((await client.next("error")).code).toBe("SESSION_REVOKED");
});

it("allows one capture per appointment at a time", async () => {
  const { v } = await recording(new FakeTranscriber());
  const second = connect(server.port, v.id, v.director.accessToken);
  await second.next("ready");
  second.send({ type: "start" });
  expect((await second.next("error")).code).toBe("CAPTURE_IN_PROGRESS");
  expect((await second.closed).code).toBe(4409);
});

it("drops the connection on an odd-length PCM frame", async () => {
  const odd = await recording(new FakeTranscriber());
  odd.client.ws.send(Buffer.alloc(3201));
  expect((await odd.client.next("error")).code).toBe("AUDIO_FRAME_INVALID");
  expect((await odd.client.closed).code).toBe(4400);
});

it("drops the connection on audio sent before the capture started", async () => {
  const v = await visitWorld();
  await v.consent();
  const early = connect(server.port, v.id, v.director.accessToken);
  await early.next("ready");
  early.ws.send(pcmFrame());
  expect((await early.next("error")).code).toBe("AUDIO_BEFORE_START");
});

it("fails with AUDIO_BACKLOG when Transcribe cannot keep up", async () => {
  await server.close();
  server = await socketServer({ heartbeatMs: 10_000, maxPendingWrites: 3 });
  let release!: () => void;
  const stalled = new FakeTranscriber(
    [],
    [],
    undefined,
    new Promise((resolve) => {
      release = () => resolve(undefined);
    })
  );
  const { client } = await recording(stalled);
  // The stalled reader holds one frame and the bounded queue (15 s = 15 frames) fills,
  // so later writes wait and the per-socket pending-write limit trips.
  for (let i = 0; i < 20; i += 1) client.ws.send(pcmFrame(0x11, 32_000));
  expect((await client.next("error")).code).toBe("AUDIO_BACKLOG");
  expect((await client.closed).code).toBe(4429);
  release();
});

it("a provider failure closes with a machine code and logs the error NAME only", async () => {
  const secret = Object.assign(new Error("User arn:aws:iam::123:user/x is not authorized"), {
    name: "AccessDeniedException",
  });
  const logs: unknown[] = [];
  const { logger } = await import("../../common/utils/logger.js");
  vi.spyOn(logger, "info").mockImplementation(((obj: unknown) => {
    logs.push(obj);
  }) as never);
  const { client } = await recording(
    new FakeTranscriber([], [], { afterChunks: 1, error: secret })
  );
  client.ws.send(pcmFrame());
  expect((await client.next("error")).code).toBe("TRANSCRIPTION_FAILED");
  expect((await client.closed).code).toBe(4500);
  expect(logs).toContainEqual(
    expect.objectContaining({
      outcome: "TRANSCRIPTION_FAILED",
      providerErrorName: "AccessDeniedException",
    })
  );
  expect(JSON.stringify(logs)).not.toContain("arn:aws");
  expect(JSON.stringify(client.messages)).not.toContain("arn:aws");
});

it("a failure while stop() drains audio never also records a clean stop", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failing = new FakeTranscriber(
    [],
    [],
    { afterChunks: 2, error: new Error("Stream reset by peer") },
    gate
  );
  const { client } = await recording(failing);
  const create = vi.spyOn(AuditEvent, "create");
  const { logger } = await import("../../common/utils/logger.js");
  const ends = vi.spyOn(logger, "info");
  client.ws.send(pcmFrame());
  client.ws.send(pcmFrame());
  await settle(50);
  client.send({ type: "stop" }); // stop() is now waiting on queued audio
  await settle(50);
  release(); // …and Transcribe fails underneath it
  expect((await client.next("error")).code).toBe("TRANSCRIPTION_FAILED");
  await client.closed;
  await settle(100);
  const attempted = create.mock.calls.flatMap(([rows]) => (Array.isArray(rows) ? rows : [rows]));
  expect(attempted.map((row) => (row as { action: string }).action)).toEqual([
    "transcription_interrupted",
  ]);
  expect(client.messages.some((m) => m.type === "stopped")).toBe(false);
  // Both failure paths (the stop() catch and the stream's failure) reach fail(); it ends once.
  const ended = ends.mock.calls.filter(([, msg]) => msg === "Visit transcription ended");
  expect(ended).toHaveLength(1);
});

it("a stalled client that stops answering pings is dropped", async () => {
  const v = await visitWorld();
  const client = connect(server.port, v.id, v.director.accessToken, { autoPong: false });
  await client.next("ready");
  expect((await client.next("error", 3_000)).code).toBe("HEARTBEAT_TIMEOUT");
});

it("own-scope providers can only capture their own appointments", async () => {
  const v = await visitWorld();
  const nurse = await staffFixture(false, 2);
  await Member.updateOne(
    { _id: v.memberRow._id },
    { $set: { assignedClinicianIds: [nurse.staff._id] } }
  );
  const { StaffMember } = await import("../staff/staff.model.js");
  await StaffMember.updateOne(
    { _id: nurse.staff._id },
    { $set: { permissionOverrides: [{ module: "APPOINTMENTS", level: "edit", scope: "own" }] } }
  );
  expect(await connect(server.port, v.id, nurse.accessToken).refused).toBe(404);
  expect((await as(nurse.accessToken).get(`/api/v1/appointments/${v.id}/visit`)).status).toBe(404);
});

// ---- W9 review fixes (each went red against the unfixed code: W9-review-red.log) ----

it("a client resetting during the upgrade cannot crash the process (review #1)", async () => {
  const v = await visitWorld();
  const { PassThrough } = await import("node:stream");
  const { IncomingMessage } = await import("node:http");
  const socket = new PassThrough();
  const req = Object.assign(new IncomingMessage(socket as never), {
    url: `/ws/appointments/${v.id}/transcription`,
    method: "GET",
    headers: { upgrade: "websocket", connection: "Upgrade" },
  });
  server.server.emit("upgrade", req, socket, Buffer.alloc(0));
  expect(() => socket.emit("error", new Error("read ECONNRESET"))).not.toThrow();
});

it("a database failure during the heartbeat fails the capture closed (review #2)", async () => {
  const { client } = await recording(new FakeTranscriber());
  const { StaffSession } = await import("../auth/auth.model.js");
  vi.spyOn(StaffSession, "exists").mockRejectedValue(new Error("connection reset"));
  expect((await client.next("error")).code).toBe("REVALIDATE_FAILED");
  expect((await client.closed).code).toBe(4500);
});

it("a revocation while the capture is starting never opens a Transcribe stream (review #5)", async () => {
  const v = await visitWorld();
  const fake = new FakeTranscriber();
  setTranscriber(fake);
  await v.consent();
  const find = TranscriptSegment.find.bind(TranscriptSegment);
  vi.spyOn(TranscriptSegment, "find").mockImplementationOnce(((
    ...args: Parameters<typeof find>
  ) => {
    emitVisitSignal(v.id, "consent_revoked");
    return find(...args);
  }) as never);
  const audits = vi.spyOn(AuditEvent, "create");
  const client = connect(server.port, v.id, v.director.accessToken);
  await client.next("ready");
  client.send({ type: "start" });
  expect((await client.next("error")).code).toBe("CONSENT_REVOKED");
  await client.closed;
  await settle(100);
  expect(fake.streams).toBe(0);
  const attempted = audits.mock.calls.flatMap(([rows]) => (Array.isArray(rows) ? rows : [rows]));
  expect(attempted.map((row) => (row as { action: string }).action)).not.toContain(
    "transcription_started"
  );
  expect(client.messages.some((m) => m.type === "started")).toBe(false);
});

it("losing Clinical Notes access mid-capture closes the socket on the next heartbeat (review #6)", async () => {
  const { v, client } = await recording(new FakeTranscriber());
  const { StaffMember } = await import("../staff/staff.model.js");
  await StaffMember.updateOne(
    { _id: v.director.staff._id },
    { $set: { permissionOverrides: [{ module: "CLINICAL_NOTES", level: "view", scope: "all" }] } }
  );
  expect((await client.next("error")).code).toBe("ACCESS_REVOKED");
  expect((await client.closed).code).toBe(4403);
});

it("a capture whose lease was taken over stops (review #9)", async () => {
  const { v, client } = await recording(new FakeTranscriber());
  await CaptureLease.updateOne({ _id: v.id }, { $set: { captureId: "someone-else" } });
  expect((await client.next("error")).code).toBe("CAPTURE_LEASE_LOST");
});
