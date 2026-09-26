import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelTurn } from "../../api/alfred/model.adapter.js";
import { alfredWorld, resetModels, useModel } from "../../test/alfredFixture.js";
import { DAY, at, pinClock } from "../../test/appointmentFixture.js";
import { Appointment } from "../appointment/appointment.model.js";
import { AuditEvent } from "../audit/audit.js";
import { MemberFlag, MemberNote } from "../member/member.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { AlfredSuggestion, AlfredUsage } from "./alfred.model.js";
import { ModelCallError } from "./model.adapter.js";
import { groundSuggestions } from "./suggestions.service.js";

beforeEach(() => pinClock());
afterEach(() => {
  resetModels();
  vi.useRealTimers();
});

const json = (body: unknown): ModelTurn => ({
  stopReason: "end_turn",
  content: [{ text: JSON.stringify(body) }],
  usage: { inputTokens: 900, outputTokens: 80 },
  latencyMs: 12,
});
const good = (title: string, sources = ["profile"]) => ({
  title,
  detail: "Because.",
  actionType: "schedule",
  sources,
});
const PATH = "/api/v1/alfred/suggestions";
/** The model input the fake received, parsed. */
const inputOf = (model: { requests: { messages?: { content?: { text?: string }[] }[] }[] }) =>
  JSON.parse(String(model.requests[0]?.messages?.[0]?.content?.[0]?.text)) as {
    sources: Record<string, unknown>;
  };

it("drops only the bad items, assigns server ids, and writes nothing to the record", () => {
  const known = new Set(["profile", "labs"]);
  const kept = groundSuggestions(
    {
      suggestions: [
        { ...good("Keep me", ["profile", "invented"]), id: "model-id" },
        good("Unknown source only", ["invented"]),
        { ...good("Bad action"), actionType: "prescribe" },
        { ...good(""), title: "" },
        "not an object",
        good("Labs", ["labs"]),
      ],
    },
    known
  );
  expect(kept).toEqual([
    { title: "Keep me", detail: "Because.", actionType: "schedule", sources: ["profile"] },
    { title: "Labs", detail: "Because.", actionType: "schedule", sources: ["labs"] },
  ]);
  expect(groundSuggestions({ nope: [] }, known)).toEqual([]);
  expect(groundSuggestions(null, known)).toEqual([]);
});

it("is explicitly unconfigured without the FAST model", async () => {
  const w = await alfredWorld();
  const api = w.http(w.director.accessToken);
  const res = await api.post(PATH, { context: "member_overview", memberId: w.memberId });
  expect([res.status, res.body.code]).toEqual([503, "AI_UNCONFIGURED"]);
  const list = await api.get(`${PATH}?context=member_overview&memberId=${w.memberId}`);
  expect(list.body.data).toMatchObject({ configured: false, items: [], total: 0 });
});

it("member suggestions: the model sees only what the staff member can read; drafts only", async () => {
  const w = await alfredWorld();
  const model = useModel("fast", [
    json({
      suggestions: [
        { ...good("Schedule Shannon's follow-up", ["profile", "labs"]), id: "model-minted" },
        good("Bad", ["nope"]),
      ],
    }),
  ]);
  const api = w.http(w.director.accessToken);
  const res = await api.post(PATH, { context: "member_overview", memberId: w.memberId });
  expect(res.status).toBe(201);
  expect(res.body.data.items).toHaveLength(1);
  expect(res.body.data.items[0].id).not.toBe("model-minted");
  expect(res.body.data.items[0]).toMatchObject({
    title: "Schedule Shannon's follow-up",
    status: "open",
  });
  expect(Object.keys(inputOf(model).sources).sort()).toEqual([
    "appointments",
    "flags",
    "labs",
    "profile",
    "protocols",
  ]);
  expect(JSON.stringify(model.requests[0])).toContain(w.panelId);
  expect(model.requests[0]?.outputConfig).toBeDefined();
  expect(await MemberNote.countDocuments()).toBe(0);
  expect(await MemberFlag.countDocuments()).toBe(0);
  expect(await Appointment.countDocuments()).toBe(0);
  expect(await AlfredUsage.findOne().lean()).toMatchObject({
    feature: "suggestions",
    modelId: model.modelId,
    inputTokens: 900,
  });
  expect(
    await AuditEvent.countDocuments({ targetType: "AlfredSuggestions", memberId: w.memberId })
  ).toBe(1);

  // Front desk: same member, no clinical sources, no lab value anywhere in the prompt.
  const fdModel = useModel("fast", [json({ suggestions: [good("Confirm contact details")] })]);
  const fd = w.http(w.frontDesk.accessToken);
  expect((await fd.post(PATH, { context: "member_overview", memberId: w.memberId })).status).toBe(
    201
  );
  expect(Object.keys(inputOf(fdModel).sources).sort()).toEqual([
    "appointments",
    "flags",
    "profile",
  ]);
  expect(JSON.stringify(fdModel.requests)).not.toContain(w.panelId);
  // Each staff member has their own list.
  expect(
    (await fd.get(`${PATH}?context=member_overview&memberId=${w.memberId}`)).body.data.items.map(
      (i: { title: string }) => i.title
    )
  ).toEqual(["Confirm contact details"]);
  // Own-scope nurse, not assigned: the member is out of scope for both reading and generating.
  const nurse = w.http(w.nurseOwn.accessToken);
  expect(
    (await nurse.post(PATH, { context: "member_overview", memberId: w.memberId })).status
  ).toBe(404);
  expect((await nurse.get(`${PATH}?context=member_overview&memberId=${w.memberId}`)).status).toBe(
    404
  );
});

it("done/dismissed once, counted as done/total, hidden when dismissed, and re-scoped on every read", async () => {
  const w = await alfredWorld();
  useModel("fast", [json({ suggestions: [good("One"), good("Two"), good("Three")] })]);
  const api = w.http(w.director.accessToken);
  const items = (await api.post(PATH, { context: "member_overview", memberId: w.memberId })).body
    .data.items;
  expect(
    (await api.post(`${PATH}/${items[0].id}/action`, { status: "done" })).body.data.status
  ).toBe("done");
  expect((await api.post(`${PATH}/${items[0].id}/action`, { status: "dismissed" })).body.code).toBe(
    "ALREADY_DECIDED"
  );
  await api.post(`${PATH}/${items[1].id}/action`, { status: "dismissed" });
  expect(
    (
      await w
        .http(w.frontDesk.accessToken)
        .post(`${PATH}/${items[2].id}/action`, { status: "done" })
    ).status
  ).toBe(404);
  const list = (await api.get(`${PATH}?context=member_overview&memberId=${w.memberId}`)).body.data;
  expect(list).toMatchObject({ done: 1, total: 3 });
  expect(list.items.map((i: { title: string }) => i.title)).toEqual(["One", "Three"]);
  // Losing member access hides stored suggestions too.
  await StaffMember.updateOne(
    { _id: w.director.staff._id },
    { $set: { permissionOverrides: [{ module: "MEMBER_RECORDS", level: "none", scope: "all" }] } }
  );
  expect((await api.get(`${PATH}?context=member_overview&memberId=${w.memberId}`)).status).toBe(
    403
  );
});

it("visit and dashboard contexts read their own sources; bad targets are refused", async () => {
  const w = await alfredWorld();
  const booked = await w.api.post(
    "/api/v1/appointments",
    w.booking(w.shannon._id, "clinician-telehealth-visit")
  );
  expect(booked.status).toBe(201);
  const appointmentId = booked.body.data.appointment._id;
  const visitModel = useModel("fast", [
    json({ suggestions: [good("Review the visit reason", ["appointment"])] }),
  ]);
  const api = w.http(w.director.accessToken);
  const visit = await api.post(PATH, { context: "visit", appointmentId });
  expect(visit.status).toBe(201);
  expect(Object.keys(inputOf(visitModel).sources)).toEqual(
    expect.arrayContaining(["appointment", "profile", "labs"])
  );
  expect(
    (await api.get(`${PATH}?context=visit&appointmentId=${appointmentId}`)).body.data.total
  ).toBe(1);
  expect(
    (await w.http(w.nobody.accessToken).post(PATH, { context: "visit", appointmentId })).status
  ).toBe(403);

  const dashModel = useModel("fast", [
    json({ suggestions: [good("Clear the lab queue", ["dashboard"])] }),
  ]);
  expect((await api.post(PATH, { context: "dashboard" })).status).toBe(201);
  expect(Object.keys(inputOf(dashModel).sources).sort()).toEqual([
    "agenda",
    "dashboard",
    "outlook",
  ]);
  for (const bad of [
    { context: "member_overview" },
    { context: "dashboard", memberId: w.memberId },
    { context: "visit" },
    { context: "member_overview", memberId: w.memberId, appointmentId },
  ])
    expect((await api.post(PATH, bad)).status).toBe(400);
});

it("a model failure or malformed output stores nothing and returns AI_FAILED", async () => {
  const w = await alfredWorld();
  const api = w.http(w.director.accessToken);
  useModel("fast", [new ModelCallError("AccessDeniedException")]);
  const failed = await api.post(PATH, { context: "dashboard" });
  expect([failed.status, failed.body.code]).toEqual([502, "AI_FAILED"]);
  useModel("fast", [{ ...json({}), content: [{ text: "not json" }] }]);
  expect((await api.post(PATH, { context: "dashboard" })).status).toBe(502);
  expect(await AlfredSuggestion.countDocuments()).toBe(0);
  expect((await AlfredUsage.find({ outcome: "error" }).lean()).map((u) => u.errorName)).toEqual([
    "AccessDeniedException",
    "ModelOutputError",
  ]);
  // Booking helper sanity: DAY is in the pinned future.
  expect(at(DAY, "09:00").getTime()).toBeGreaterThan(Date.now());
});
