import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { alfredWorld, loadStaff } from "../../test/alfredFixture.js";
import { DAY, at, pinClock } from "../../test/appointmentFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { TOOLS, modelResult, runTool, toolConfig } from "./tools.js";

beforeEach(() => pinClock());
afterEach(() => vi.useRealTimers());

type World = Awaited<ReturnType<typeof alfredWorld>>;
type Case = [
  tool: string,
  args: (w: World) => Record<string, unknown>,
  http: (w: World) => [string, string, object?],
];
const m = (w: World) => `/api/v1/members/${w.memberId}`;
/** Each read tool, with the HTTP request a staff member would make for the same data. */
const CASES: Case[] = [
  ["search_members", () => ({ q: "Ashton" }), () => ["get", "/api/v1/members/search?q=Ashton"]],
  ["member_summary", (w) => ({ memberId: w.memberId }), (w) => ["get", `${m(w)}/overview`]],
  ["member_flags", (w) => ({ memberId: w.memberId }), (w) => ["get", `${m(w)}/flags`]],
  [
    "member_appointments",
    (w) => ({ memberId: w.memberId, scope: "all" }),
    (w) => ["get", `${m(w)}/appointments?scope=all`],
  ],
  ["member_lab_panels", (w) => ({ memberId: w.memberId }), (w) => ["get", `${m(w)}/lab-panels`]],
  [
    "member_lab_panel",
    (w) => ({ memberId: w.memberId, panelId: w.panelId }),
    (w) => ["get", `${m(w)}/lab-panels/${w.panelId}`],
  ],
  [
    "member_health_summary",
    (w) => ({ memberId: w.memberId }),
    (w) => ["get", `${m(w)}/health-summary`],
  ],
  ["member_protocols", (w) => ({ memberId: w.memberId }), (w) => ["get", `${m(w)}/protocols`]],
  ["list_services", () => ({}), () => ["get", "/api/v1/services?status=active&limit=50"]],
  ["list_locations", () => ({}), () => ["get", "/api/v1/locations"]],
  [
    "find_availability",
    (w) => ({
      serviceId: w.service("clinician-telehealth-visit"),
      locationId: String(w.vegas._id),
      from: DAY,
    }),
    (w) => [
      "get",
      `/api/v1/availability?serviceId=${w.service("clinician-telehealth-visit")}&locationId=${w.vegas._id}&from=${DAY}`,
    ],
  ],
  [
    "quote_appointment",
    (w) => ({
      memberId: w.memberId,
      serviceId: w.service("clinician-telehealth-visit"),
      locationId: String(w.vegas._id),
      startAt: at(DAY, "09:00").toISOString(),
    }),
    (w) => [
      "post",
      "/api/v1/appointments/quote",
      {
        memberId: w.memberId,
        serviceId: w.service("clinician-telehealth-visit"),
        locationId: String(w.vegas._id),
        startAt: at(DAY, "09:00").toISOString(),
      },
    ],
  ],
  ["staff_schedule", () => ({ date: DAY }), () => ["get", `/api/v1/staff/shifts?date=${DAY}`]],
  ["time_off_requests", () => ({}), () => ["get", "/api/v1/staff/pto-requests"]],
  ["my_dashboard", () => ({ date: DAY }), () => ["get", `/api/v1/dashboard/summary?date=${DAY}`]],
  ["my_agenda", () => ({ date: DAY }), () => ["get", `/api/v1/dashboard/agenda?date=${DAY}`]],
];
/** Strip values that legitimately differ between two reads (none today; kept explicit). */
const same = (value: unknown) => JSON.parse(JSON.stringify(value));

it("covers every read tool, and every tool has an object schema", () => {
  const reads = TOOLS.filter((t) => !t.name.startsWith("propose_")).map((t) => t.name);
  expect(CASES.map((c) => c[0]).sort()).toEqual(reads.sort());
  for (const spec of toolConfig().tools)
    expect(spec.toolSpec?.inputSchema?.json).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
});

it("every read tool returns exactly what the same staff member gets over HTTP, and nothing when HTTP refuses", async () => {
  const w = await alfredWorld();
  const roles = {
    director: w.director,
    frontDesk: w.frontDesk,
    nurseOwn: w.nurseOwn,
    nobody: w.nobody,
  };
  const refusals: Record<string, string[]> = {};
  for (const [name, fixture] of Object.entries(roles)) {
    const staff = await loadStaff(fixture.staff._id);
    for (const [tool, args, http] of CASES) {
      const [method, path, body] = http(w);
      const api = w.http(fixture.accessToken);
      const res = method === "get" ? await api.get(path) : await api.post(path, body);
      const out = await runTool(
        { actor: { staff }, conversationId: null, draftIds: [] },
        tool,
        args(w)
      );
      if (res.status >= 400) {
        expect({ name, tool, out }).toEqual({
          name,
          tool,
          out: { error: expect.objectContaining({ status: res.status, code: res.body.code }) },
        });
        expect(out).not.toHaveProperty("result");
        refusals[name] = [...(refusals[name] ?? []), tool];
      } else {
        expect({ name, tool, status: res.status }).toEqual({ name, tool, status: 200 });
        expect(same(out["result"])).toEqual(same(res.body.data));
      }
    }
  }
  // The denied roles really were denied (the parity check alone could pass vacuously).
  expect(refusals["frontDesk"]).toEqual(
    expect.arrayContaining([
      "member_lab_panels",
      "member_lab_panel",
      "member_health_summary",
      "member_protocols",
    ])
  );
  expect(refusals["frontDesk"]).not.toContain("member_summary");
  expect(refusals["nurseOwn"]).toEqual(
    expect.arrayContaining([
      "member_summary",
      "member_lab_panel",
      "member_protocols",
      "quote_appointment",
    ])
  );
  expect(refusals["nobody"]).toEqual(
    expect.arrayContaining(
      CASES.map((c) => c[0]).filter(
        (t) => !["list_locations", "my_dashboard", "my_agenda"].includes(t)
      )
    )
  );
  expect(refusals["director"]).toBeUndefined();
});

it("a PHI read through a tool is audited exactly like the HTTP read", async () => {
  const w = await alfredWorld();
  const staff = await loadStaff(w.director.staff._id);
  const rows = () =>
    AuditEvent.find({ actorId: String(staff._id), memberId: w.memberId })
      .select("action targetType targetId -_id")
      .lean();
  const before = (await rows()).length;
  await runTool(
    { actor: { staff, requestId: "req-tool" }, conversationId: null, draftIds: [] },
    "member_lab_panel",
    {
      memberId: w.memberId,
      panelId: w.panelId,
    }
  );
  const viaTool = (await rows()).slice(before);
  await w.http(w.director.accessToken).get(`${m(w)}/lab-panels/${w.panelId}`);
  const viaHttp = (await rows()).slice(before + viaTool.length);
  expect(viaTool.length).toBeGreaterThan(0);
  expect(viaTool).toEqual(viaHttp);
  expect(await AuditEvent.countDocuments({ requestId: "req-tool" })).toBe(viaTool.length);
});

it("rejects unknown tools and arguments the route schema refuses, without calling the handler", async () => {
  const w = await alfredWorld();
  const staff = await loadStaff(w.director.staff._id);
  const ctx = { actor: { staff }, conversationId: null, draftIds: [] };
  expect(await runTool(ctx, "drop_database", {})).toEqual({
    error: expect.objectContaining({ code: "UNKNOWN_TOOL" }),
  });
  const bad = await runTool(ctx, "member_summary", { memberId: "not-an-id" });
  expect(bad).toEqual({
    error: expect.objectContaining({ status: 400, code: "VALIDATION_ERROR" }),
  });
  const arrayInput = await runTool(ctx, "search_members", ["Ashton"]);
  expect(arrayInput).toEqual({ error: expect.objectContaining({ status: 400 }) });
});

it("always hands the model a JSON object, truncating large results", () => {
  expect(modelResult({ ok: true, data: [1, 2] })).toEqual({ result: [1, 2] });
  const big = modelResult({ ok: true, data: { text: "x".repeat(20_000) } });
  expect(big).toMatchObject({ truncated: true });
  expect(String(big["partialJson"]).length).toBe(12_000);
  expect(modelResult({ ok: false, status: 403, code: "FORBIDDEN", message: "Forbidden" })).toEqual({
    error: { status: 403, code: "FORBIDDEN", message: "Forbidden" },
  });
});
