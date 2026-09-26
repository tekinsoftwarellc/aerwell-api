import type { Tool } from "@aws-sdk/client-bedrock-runtime";
import { VISIT_REASONS } from "../appointment/appointment.model.js";
import { FLAG_CATEGORIES } from "../member/member.model.js";
import { PTO_STATUSES, PTO_TYPES } from "../schedule/schedule.schema.js";
import { FULFILMENT } from "../supplement/supplement.js";
import type { DraftKind } from "./alfred.model.js";
import { type Actor, type RouteInput, type RouteOutcome, callRoute } from "./dispatch.js";
import { proposeDraft } from "./drafts.service.js";

/**
 * Alfred AI tools. Every READ tool is one mounted HTTP route, called in-process
 * as the acting staff member (see dispatch.ts). Every WRITE is a `propose_*` tool
 * that only stores a draft; the staff member confirms it in the UI.
 */
type Args = Record<string, unknown>;
type Prop = { type: string; description?: string; enum?: readonly string[]; items?: Prop };
export interface ToolContext {
  actor: Actor;
  conversationId: string | null;
  draftIds: string[];
}
interface ToolDef {
  name: string;
  description: string;
  props: Record<string, Prop>;
  required?: string[];
  run(ctx: ToolContext, args: Args): Promise<RouteOutcome>;
}

const id = (description: string): Prop => ({ type: "string", description });
const s = (description: string, values?: readonly string[]): Prop => ({
  type: "string",
  description,
  ...(values ? { enum: values } : {}),
});
const n = (description: string): Prop => ({ type: "integer", description });
const DATE = "Local date YYYY-MM-DD";
const pick = (args: Args, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
const member = (args: Args, extra: Record<string, unknown> = {}) => ({
  id: args["memberId"],
  ...extra,
});

function read(
  name: string,
  route: string,
  description: string,
  props: Record<string, Prop>,
  map: (args: Args) => RouteInput,
  required: string[] = []
): ToolDef {
  return {
    name,
    description,
    props,
    required,
    run: (ctx, args) => callRoute(ctx.actor, route, map(args)),
  };
}
function propose(
  kind: DraftKind,
  description: string,
  props: Record<string, Prop>,
  required: string[]
): ToolDef {
  return {
    name: `propose_${kind}`,
    description: `${description} This only creates a DRAFT; the staff member reviews and confirms it in the app. Never say it is done.`,
    props,
    required,
    async run(ctx, args) {
      const outcome = await proposeDraft(ctx.actor, kind, args, ctx.conversationId);
      if (outcome.ok) ctx.draftIds.push((outcome.data as { id: string }).id);
      return outcome;
    },
  };
}

const memberId = { memberId: id("Member id from search_members") };
export const TOOLS: ToolDef[] = [
  read(
    "search_members",
    "GET /members/search",
    "Find members by ONE first name, last name or email fragment (up to 10). Returns member ids.",
    { q: s("A single name or email fragment") },
    (a) => ({ query: pick(a, ["q"]) }),
    ["q"]
  ),
  read(
    "member_summary",
    "GET /members/:id/overview",
    "A member's profile summary: status, memberships, flags, notes count, visit stats.",
    memberId,
    (a) => ({ params: member(a) }),
    ["memberId"]
  ),
  read(
    "member_flags",
    "GET /members/:id/flags",
    "A member's flags and alerts.",
    { ...memberId, state: s("Which flags", ["active", "resolved", "all"]) },
    (a) => ({ params: member(a), query: pick(a, ["state"]) }),
    ["memberId"]
  ),
  read(
    "member_appointments",
    "GET /members/:id/appointments",
    "A member's appointments.",
    { ...memberId, scope: s("Which appointments", ["upcoming", "past", "all"]) },
    (a) => ({ params: member(a), query: pick(a, ["scope"]) }),
    ["memberId"]
  ),
  read(
    "member_lab_panels",
    "GET /members/:id/lab-panels",
    "A member's lab panels (summary list with out-of-range counts).",
    memberId,
    (a) => ({ params: member(a) }),
    ["memberId"]
  ),
  read(
    "member_lab_panel",
    "GET /members/:id/lab-panels/:panelId",
    "One lab panel with every biomarker result.",
    { ...memberId, panelId: id("Panel id from member_lab_panels") },
    (a) => ({ params: member(a, { panelId: a["panelId"] }) }),
    ["memberId", "panelId"]
  ),
  read(
    "member_health_summary",
    "GET /members/:id/health-summary",
    "A member's health score, biological age, latest labs and scans summary.",
    memberId,
    (a) => ({ params: member(a) }),
    ["memberId"]
  ),
  read(
    "member_protocols",
    "GET /members/:id/protocols",
    "A member's treatment protocols.",
    { ...memberId, status: s("Filter", ["active", "completed", "discontinued", "all"]) },
    (a) => ({ params: member(a), query: pick(a, ["status"]) }),
    ["memberId"]
  ),
  read(
    "list_services",
    "GET /services",
    "The clinic's services (ids, titles, durations).",
    { q: s("Optional title search") },
    (a) => ({ query: { status: "active", limit: 50, ...pick(a, ["q"]) } })
  ),
  read(
    "list_locations",
    "GET /locations",
    "The clinic locations (ids, names, time zones).",
    {},
    () => ({})
  ),
  read(
    "find_availability",
    "GET /availability",
    "Open appointment slots for a service at a location between two local dates.",
    {
      serviceId: id("Service id"),
      locationId: id("Location id"),
      providerId: id("Optional provider id"),
      from: s(DATE),
      to: s(`${DATE} (optional)`),
    },
    (a) => ({ query: pick(a, ["serviceId", "locationId", "providerId", "from", "to"]) }),
    ["serviceId", "locationId", "from"]
  ),
  read(
    "quote_appointment",
    "POST /appointments/quote",
    "Price and entitlement for a member booking a service at a time.",
    {
      ...memberId,
      serviceId: id("Service id"),
      locationId: id("Location id"),
      startAt: s("ISO-8601 start with offset"),
    },
    (a) => ({ body: pick(a, ["memberId", "serviceId", "locationId", "startAt"]) }),
    ["memberId", "serviceId", "locationId", "startAt"]
  ),
  read(
    "staff_schedule",
    "GET /staff/shifts",
    "Staff shifts for a day, week or month.",
    { date: s(DATE), view: s("Range", ["day", "week", "month"]), staffId: id("Optional staff id") },
    (a) => ({ query: pick(a, ["date", "view", "staffId"]) }),
    ["date"]
  ),
  read(
    "time_off_requests",
    "GET /staff/pto-requests",
    "Time-off (PTO) requests visible to the staff member.",
    { status: s("Filter", PTO_STATUSES) },
    (a) => ({ query: pick(a, ["status"]) })
  ),
  read(
    "my_dashboard",
    "GET /dashboard/summary",
    "The staff member's dashboard counters for a day (appointments, labs to review, notes, waitlists, staff today).",
    { date: s(`${DATE} (optional, default today)`) },
    (a) => ({ query: pick(a, ["date"]) })
  ),
  read(
    "my_agenda",
    "GET /dashboard/agenda",
    "The staff member's own appointments for a day.",
    { date: s(`${DATE} (optional, default today)`) },
    (a) => ({ query: pick(a, ["date"]) })
  ),
  propose(
    "book_appointment",
    "Propose booking an appointment. Use ids from list_services, list_locations, find_availability and search_members.",
    {
      ...memberId,
      serviceId: id("Service id"),
      providerId: id("Provider staff id from find_availability"),
      locationId: id("Location id"),
      startAt: s("ISO-8601 start with offset, from find_availability"),
      reason: s("Visit reason", VISIT_REASONS),
      reasonDetail: s("Optional context"),
    },
    ["memberId", "serviceId", "providerId", "locationId", "startAt"]
  ),
  propose(
    "add_note",
    "Propose a clinical note on a member.",
    { ...memberId, body: s("Note text") },
    ["memberId", "body"]
  ),
  propose(
    "create_flag",
    "Propose a flag on a member.",
    {
      ...memberId,
      category: s("Category", FLAG_CATEGORIES),
      title: s("Short title"),
      description: s("Optional detail"),
      severity: s("Severity", ["urgent", "open"]),
    },
    ["memberId", "category", "title"]
  ),
  propose(
    "request_pto",
    "Propose a time-off request for the staff member themself.",
    { startDate: s(DATE), endDate: s(DATE), type: s("Type", PTO_TYPES), note: s("Optional note") },
    ["startDate", "endDate", "type"]
  ),
  propose(
    "supplement_order",
    "Propose a DRAFT supplement order (never placed, charged or shipped). Product ids come from the supplement catalog in the member's record screen; ask the staff member if unknown.",
    {
      ...memberId,
      productId: id("Supplement product id"),
      directions: s("Dosing directions"),
      durationDays: n("Days"),
      qty: n("Quantity"),
      fulfillment: s("Fulfilment", FULFILMENT),
      noteToMember: s("Optional note to the member"),
    },
    ["memberId", "productId", "directions", "durationDays", "qty", "fulfillment"]
  ),
];
const byName = new Map(TOOLS.map((t) => [t.name, t]));

export const toolConfig = (): { tools: Tool[] } => ({
  tools: TOOLS.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: {
        json: {
          type: "object",
          properties: t.props,
          required: t.required ?? [],
          additionalProperties: false,
        },
      },
    },
  })) as unknown as Tool[],
});

const MAX_RESULT_CHARS = 12_000;
/** The model always gets a JSON object (Converse `json` must be a document, not a bare array). */
export function modelResult(outcome: RouteOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    const { ok: Ok, ...error } = outcome;
    return { error };
  }
  const text = JSON.stringify(outcome.data ?? null);
  return text.length > MAX_RESULT_CHARS
    ? { truncated: true, partialJson: text.slice(0, MAX_RESULT_CHARS) }
    : { result: JSON.parse(text) };
}

export async function runTool(ctx: ToolContext, name: string, input: unknown) {
  const tool = byName.get(name);
  if (!tool) return { error: { status: 404, code: "UNKNOWN_TOOL", message: "No such tool" } };
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Args) : {};
  return modelResult(await tool.run(ctx, args));
}
