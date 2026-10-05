import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Member } from "./api/member/member.model.js";
import { setTranscriber } from "./api/visit/transcribe.adapter.js";
import { emitVisitSignal } from "./api/visit/visit.events.js";
import {
  LAB_SENTINEL,
  alfredWorld,
  resetModels,
  textTurn,
  toolTurn,
  useModel,
} from "./test/alfredFixture.js";
import { pinClock } from "./test/appointmentFixture.js";
import {
  FakeTranscriber,
  connect,
  final,
  pcmFrame,
  socketServer,
  visitWorld,
} from "./test/visitFixture.js";

/**
 * W11 no-PHI log check: every log line the app writes (request logs included)
 * is captured while real flows run with sentinel PHI, then searched for it.
 */
const sink = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("./common/utils/logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./common/utils/logger.js")>();
  const capture = {
    write: (line: string) => {
      sink.lines.push(line);
    },
  };
  return { ...real, logger: real.createLogger(capture as never) };
});
vi.mock("./common/middleware/requestLogger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./common/middleware/requestLogger.js")>();
  const { logger } = await import("./common/utils/logger.js");
  return { ...real, requestLogger: real.createRequestLogger(logger, true) };
});

const PHI = {
  firstName: "Zyxwvutsrq",
  lastName: "Qwertyuiopl",
  email: "phi.sentinel@example.invalid",
  phone: "702-555-0199",
  dateOfBirth: "1961-07-04",
  contact: "Kinfolk Sentinelname",
  intake: "INTAKE-SENTINEL-TEXT",
  note: "NOTE-SENTINEL-BODY",
  flag: "FLAG-SENTINEL-TITLE",
  chat: "CHAT-SENTINEL-QUESTION",
  transcript: "TRANSCRIPT-SENTINEL-LINE",
  lab: String(LAB_SENTINEL),
};
function assertNoPhi(extra: string[] = []) {
  // Strip hex ids first: they contain arbitrary digit runs.
  const text = sink.lines
    .join("\n")
    // Only pino's own timestamp: a DOB logged as an ISO date must still be caught.
    .replace(/"time":"[^"]*"/g, '""')
    .replace(/[a-f\d]{24}/gi, "");
  const leaked = [...Object.values(PHI), ...extra].filter((value) =>
    text.toLowerCase().includes(value.toLowerCase())
  );
  expect(leaked).toEqual([]);
}
beforeEach(() => {
  pinClock();
  sink.lines.length = 0;
});
afterEach(() => {
  resetModels();
  setTranscriber(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("member, clinical, booking, Alfred and error flows log no PHI", async () => {
  const w = await alfredWorld();
  const api = w.http(w.director.accessToken);
  const person = {
    firstName: PHI.firstName,
    lastName: PHI.lastName,
    email: PHI.email,
    phone: PHI.phone,
    dateOfBirth: PHI.dateOfBirth,
    emergencyContact: { name: PHI.contact, phone: PHI.phone },
    intakeNote: PHI.intake,
  };
  const created = await api.post("/api/v1/members", person);
  expect(created.status).toBe(201);
  const id = created.body.data._id as string;
  expect((await api.post("/api/v1/members", person)).status).toBe(409);
  expect((await api.post("/api/v1/members", { ...person, email: PHI.firstName })).status).toBe(400);
  expect((await api.patch(`/api/v1/members/${id}`, { phone: PHI.phone })).status).toBe(200);
  expect((await api.post(`/api/v1/members/${id}/notes`, { body: PHI.note })).status).toBe(201);
  const flag = { category: "clinical", title: PHI.flag };
  expect((await api.post(`/api/v1/members/${id}/flags`, flag)).status).toBe(201);
  expect((await api.get(`/api/v1/members?q=${PHI.lastName}`)).status).toBe(200);
  expect((await api.get(`/api/v1/members/search?q=${PHI.firstName}`)).status).toBe(200);
  expect((await api.get(`/api/v1/members/${w.memberId}/lab-panels/${w.panelId}`)).status).toBe(200);
  const booking = await api.post("/api/v1/appointments", w.booking(id, "dexa-scan"));
  expect(booking.status).toBeLessThan(500);
  // A 500 whose error message carries PHI.
  vi.spyOn(Member, "findOne").mockImplementationOnce(() => {
    throw new Error(`lookup failed for ${PHI.email} ${PHI.dateOfBirth}`);
  });
  expect((await api.get(`/api/v1/members/${id}`)).status).toBe(500);
  // Alfred: a tool turn reading the lab panel, then a failed model call.
  useModel("smart", [
    toolTurn({ name: "member_lab_panel", input: { memberId: w.memberId, panelId: w.panelId } }),
    textTurn(`TSH is ${PHI.lab} for ${PHI.firstName}`),
  ]);
  const convo = await api.post("/api/v1/alfred/conversations");
  const chat = `/api/v1/alfred/conversations/${convo.body.data.id}/messages`;
  expect((await api.post(chat, { text: `${PHI.chat} ${PHI.lastName}` })).status).toBe(200);
  useModel("smart", [new Error(`Provider echoed ${PHI.chat} ${PHI.email}`)]);
  expect((await api.post(chat, { text: PHI.chat })).status).toBe(502);
  // The capture is live: request, error and Alfred lines were written.
  expect(sink.lines.length).toBeGreaterThan(20);
  expect(sink.lines.some((line) => line.includes("Request failed"))).toBe(true);
  expect(sink.lines.some((line) => line.includes('"statusCode":201'))).toBe(true);
  assertNoPhi(["Shannon", "Ashton"]);
});

it("live visit transcription logs no transcript text or member details", async () => {
  const server = await socketServer({ heartbeatMs: 150, startTimeoutMs: 2_000 });
  try {
    const v = await visitWorld();
    await Member.updateOne(
      { _id: v.memberRow._id },
      { firstName: PHI.firstName, lastName: PHI.lastName, email: PHI.email }
    );
    setTranscriber(new FakeTranscriber([[final(0, "spk_0", PHI.transcript)]]));
    expect((await v.consent()).status).toBe(201);
    const client = connect(server.port, v.id, v.director.accessToken);
    await client.next("ready");
    client.send({ type: "start" });
    await client.next("started");
    client.ws.send(pcmFrame());
    expect((await client.next("transcript")).text).toBe(PHI.transcript);
    expect((await v.api.get(`/api/v1/appointments/${v.id}/transcript`)).status).toBe(200);
    emitVisitSignal(v.id, "consent_revoked");
    await client.closed;
    expect(sink.lines.some((line) => line.includes("Visit transcription ended"))).toBe(true);
    assertNoPhi();
  } finally {
    await server.close();
  }
});
