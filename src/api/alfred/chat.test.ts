import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  LAB_SENTINEL,
  alfredWorld,
  resetModels,
  textTurn,
  toolTurn,
  useModel,
} from "../../test/alfredFixture.js";
import { pinClock } from "../../test/appointmentFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { AlfredConversation, AlfredDraft, AlfredMessage, AlfredUsage } from "./alfred.model.js";
import { RATE } from "./chat.service.js";
import { ModelCallError } from "./model.adapter.js";

beforeEach(() => pinClock());
afterEach(() => {
  resetModels();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Api = ReturnType<Awaited<ReturnType<typeof alfredWorld>>["http"]>;
async function conversation(api: Api) {
  const res = await api.post("/api/v1/alfred/conversations");
  expect(res.status).toBe(201);
  return String(res.body.data.id);
}
const say = (api: Api, id: string, text: string) =>
  api.post(`/api/v1/alfred/conversations/${id}/messages`, { text });

it("is explicitly unconfigured without a model, and says so in config", async () => {
  const w = await alfredWorld();
  const api = w.http(w.director.accessToken);
  const id = await conversation(api);
  const res = await say(api, id, "Hello");
  expect(res.status).toBe(503);
  expect(res.body.code).toBe("AI_UNCONFIGURED");
  expect((await api.get("/api/v1/alfred/config")).body.data).toEqual({
    chat: false,
    suggestions: false,
  });
  expect(await AlfredMessage.countDocuments()).toBe(0);
});

it("answers with tools run as the staff member; history is visible text only, never tool plumbing", async () => {
  const w = await alfredWorld();
  const model = useModel("smart", [
    toolTurn({ name: "search_members", input: { q: "Ashton" } }),
    toolTurn({ name: "member_lab_panel", input: { memberId: w.memberId, panelId: w.panelId } }),
    textTurn("Shannon's latest panel is back; one marker needs a look."),
  ]);
  const api = w.http(w.director.accessToken);
  const id = await conversation(api);
  const res = await say(api, id, "How are Shannon's labs?");
  expect(res.status).toBe(200);
  expect(
    res.body.data.messages.map((m: { role: string; text: string }) => [m.role, m.text])
  ).toEqual([
    ["user", "How are Shannon's labs?"],
    ["assistant", "Shannon's latest panel is back; one marker needs a look."],
  ]);
  // The model got real data, as JSON objects, from the director's own reads.
  const [search, panel] = model.toolResults();
  expect(JSON.stringify(search)).toContain(w.memberId);
  expect(JSON.stringify(panel)).toContain(String(LAB_SENTINEL));
  expect(model.requests[0]?.toolConfig?.tools?.length).toBeGreaterThan(10);
  expect(JSON.stringify(model.requests[0]?.system)).toContain("Alfred AI");
  // Sonnet 5 (the SMART tier) rejects `temperature` with ValidationException.
  expect(model.requests[0]?.inferenceConfig).not.toHaveProperty("temperature");

  const history = await api.get(`/api/v1/alfred/conversations/${id}/messages`);
  const body = JSON.stringify(history.body);
  for (const leak of [
    "toolUse",
    "toolResult",
    "search_members",
    "member_lab_panel",
    String(LAB_SENTINEL),
    "tooluse-",
  ])
    expect(body).not.toContain(leak);
  expect(history.body.data.messages).toHaveLength(2);
  expect(Object.keys(history.body.data.messages[1]).sort()).toEqual([
    "createdAt",
    "drafts",
    "id",
    "role",
    "text",
  ]);
  // Nothing but visible text was ever persisted.
  const stored = JSON.stringify(await AlfredMessage.find().lean());
  expect(stored).not.toContain(String(LAB_SENTINEL));
  expect(stored).not.toContain("toolUse");
  // Tool reads were audited as the director.
  expect(
    await AuditEvent.countDocuments({
      actorId: String(w.director.staff._id),
      memberId: w.memberId,
      action: "viewed",
    })
  ).toBeGreaterThan(0);
  // Usage: tokens only, no content.
  const usage = await AlfredUsage.findOne().lean();
  expect(usage).toMatchObject({
    feature: "chat",
    modelId: model.modelId,
    inputTokens: 360,
    outputTokens: 90,
    toolCalls: 2,
    outcome: "ok",
  });
  expect(JSON.stringify(usage)).not.toContain("Shannon");
  // The second turn replays only the visible history.
  const next = useModel("smart", [textTurn("You're welcome.")]);
  await say(api, id, "Thanks");
  expect(next.requests[0]?.messages?.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(JSON.stringify(next.requests[0]?.messages)).not.toContain(String(LAB_SENTINEL));
});

it("front desk asking for labs is refused by the tool; no lab data reaches the model", async () => {
  const w = await alfredWorld();
  const model = useModel("smart", [
    toolTurn({ name: "member_lab_panel", input: { memberId: w.memberId, panelId: w.panelId } }),
    textTurn("You don't have access to lab results."),
  ]);
  const api = w.http(w.frontDesk.accessToken);
  const res = await say(api, await conversation(api), "Show me Shannon's labs");
  expect(res.status).toBe(200);
  const [result] = model.toolResults();
  expect(result).toEqual({ error: expect.objectContaining({ status: 403, code: "FORBIDDEN" }) });
  expect(JSON.stringify(model.requests)).not.toContain(String(LAB_SENTINEL));
  const toolResult = model.requests[1]?.messages?.at(-1)?.content?.[0] as {
    toolResult: { status: string };
  };
  expect(toolResult.toolResult.status).toBe("error");
});

it("keeps every conversation private to its staff member", async () => {
  const w = await alfredWorld();
  useModel("smart", [textTurn("Noted.")]);
  const director = w.http(w.director.accessToken);
  const id = await conversation(director);
  await say(director, id, "PRIVATE-DIRECTOR-NOTE about Shannon");
  const nurse = w.http(w.nurseOwn.accessToken);
  expect((await nurse.get(`/api/v1/alfred/conversations/${id}/messages`)).status).toBe(404);
  expect((await say(nurse, id, "read it")).status).toBe(404);
  expect((await nurse.get("/api/v1/alfred/conversations")).body.data.items).toEqual([]);
  // A row forged under another organization with the same staff id never loads.
  await AlfredConversation.updateOne({ _id: id }, { $set: { organizationId: "org-other" } });
  expect((await director.get(`/api/v1/alfred/conversations/${id}/messages`)).status).toBe(404);
  await AlfredConversation.updateOne({ _id: id }, { $set: { organizationId: "org-test" } });
  await AlfredMessage.updateMany({ conversationId: id }, { $set: { organizationId: "org-other" } });
  const replay = useModel("smart", [textTurn("Hi.")]);
  await say(director, id, "again");
  expect(JSON.stringify(replay.requests)).not.toContain("PRIVATE-DIRECTOR-NOTE");
  // The nurse's own conversation never sees the director's words.
  const own = useModel("smart", [textTurn("Hello.")]);
  await say(nurse, await conversation(nurse), "hello");
  expect(JSON.stringify(own.requests)).not.toContain("PRIVATE-DIRECTOR-NOTE");
});

it("rate-limits per staff member, not per clinic", async () => {
  const w = await alfredWorld();
  useModel(
    "smart",
    Array.from({ length: RATE.chat + 2 }, () => textTurn("ok"))
  );
  const director = w.http(w.director.accessToken);
  const id = await conversation(director);
  for (let i = 0; i < RATE.chat; i += 1)
    expect((await say(director, id, `m${i}`)).status).toBe(200);
  const limited = await say(director, id, "one more");
  expect(limited.status).toBe(429);
  expect(limited.body.code).toBe("AI_RATE_LIMITED");
  const nurse = w.http(w.nurseOwn.accessToken);
  expect((await say(nurse, await conversation(nurse), "hi")).status).toBe(200);
});

it("a model failure persists nothing, cancels that turn's drafts, and logs no PHI", async () => {
  const w = await alfredWorld();
  const { logger } = await import("../../common/utils/logger.js");
  const lines: string[] = [];
  for (const level of ["info", "warn", "error", "debug"] as const)
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    }) as never);
  useModel("smart", [
    toolTurn({
      name: "propose_add_note",
      input: { memberId: w.memberId, body: "Shannon Ashton SECRET-NOTE" },
    }),
    new ModelCallError("ThrottlingException"),
  ]);
  const api = w.http(w.director.accessToken);
  const id = await conversation(api);
  const res = await say(api, id, "Note that Shannon Ashton feels tired");
  expect(res.status).toBe(502);
  expect(res.body.code).toBe("AI_FAILED");
  expect(await AlfredMessage.countDocuments()).toBe(0);
  expect(await AlfredDraft.find().select("status -_id").lean()).toEqual([{ status: "cancelled" }]);
  expect(await AlfredUsage.findOne({ outcome: "error" }).lean()).toMatchObject({
    errorName: "ThrottlingException",
  });
  const logged = lines.join("\n");
  expect(logged).toContain("ThrottlingException");
  for (const phi of ["Shannon", "Ashton", "SECRET-NOTE", "tired", String(LAB_SENTINEL)])
    expect(logged).not.toContain(phi);
});

it("stops after the tool-round cap with a safe reply, and rejects bad input", async () => {
  const w = await alfredWorld();
  useModel(
    "smart",
    Array.from({ length: 6 }, () => toolTurn({ name: "list_locations", input: {} }))
  );
  const api = w.http(w.director.accessToken);
  const id = await conversation(api);
  const res = await say(api, id, "loop");
  expect(res.body.data.messages[1].text).toMatch(/couldn't finish/);
  expect((await say(api, id, "")).status).toBe(400);
  expect(
    (await api.post(`/api/v1/alfred/conversations/${id}/messages`, { text: "x", role: "system" }))
      .status
  ).toBe(400);
  expect(
    (await api.get("/api/v1/alfred/conversations/000000000000000000000000/messages")).status
  ).toBe(404);
  expect((await api.get("/api/v1/alfred/conversations")).body.data.items).toMatchObject([
    { id, title: "loop" },
  ]);
});

it("repairs a history that does not alternate, so one bad row never breaks the conversation", async () => {
  const w = await alfredWorld();
  useModel("smart", [textTurn("First.")]);
  const api = w.http(w.director.accessToken);
  const id = await conversation(api);
  await say(api, id, "one");
  const base = { organizationId: "org-test", staffId: w.director.staff._id, conversationId: id };
  await AlfredMessage.create({
    ...base,
    role: "user",
    text: "orphan without a reply",
    createdAt: new Date(Date.now() + 5),
  });
  const model = useModel("smart", [textTurn("Fine.")]);
  expect((await say(api, id, "two")).status).toBe(200);
  const roles = model.requests[0]?.messages?.map((m) => m.role);
  expect(roles).toEqual(["user", "assistant", "user"]);
  expect(JSON.stringify(model.requests[0]?.messages?.at(-1))).toContain("orphan without a reply");
  expect(JSON.stringify(model.requests[0]?.messages?.at(-1))).toContain("two");
  // A window that starts on an assistant turn is trimmed to start with the user.
  await AlfredMessage.deleteMany({ role: "user", conversationId: id, text: "one" });
  const again = useModel("smart", [textTurn("Ok.")]);
  await say(api, id, "three");
  expect(again.requests[0]?.messages?.[0]?.role).toBe("user");
});
