import type { Request } from "express";
import { Types } from "mongoose";
import { AppError, ConflictError, NotFoundError } from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { Location } from "../location/location.model.js";
import { Member } from "../member/member.model.js";
import { Service } from "../service/service.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { AlfredDraft, type DraftKind } from "./alfred.model.js";
import {
  type Actor,
  type RouteInput,
  type RouteOutcome,
  callRoute,
  prepareRoute,
} from "./dispatch.js";

/**
 * Write actions Alfred may PROPOSE. A draft stores the exact input for the target
 * route, validated by that route's own guard and schema when proposed; nothing is
 * written until the staff member confirms, and confirming runs the same route
 * again (guard, schema, handler, audit) as the confirming staff member.
 * Previews come from database lookups, never from model text.
 */
type Args = Record<string, unknown>;
type Prechecked = { ok: true; data?: unknown } | Extract<RouteOutcome, { ok: false }>;
interface KindSpec {
  route: string;
  /** Body keys the staff member may edit in the confirmation dialog (text only). */
  editable: string[];
  input(args: Args): RouteInput;
  precheck(actor: Actor, input: RouteInput): Promise<Prechecked>;
  preview(input: RouteInput, prechecked: unknown): Promise<Record<string, unknown>>;
  /** Called with the new draft id so the stored input can carry server-made values. */
  finalize?(input: RouteInput, draftId: string, prechecked: unknown): RouteInput;
  resultOf(data: unknown): { targetType: string; targetId: string };
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const pick = (args: Args, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
const bodyOf = (input: RouteInput) => (input.body ?? {}) as Record<string, unknown>;
const memberParam = (args: Args) => ({ id: str(args["memberId"]) ?? "" });
const idOf = (data: unknown, key?: string) => {
  const row = (key ? (data as Record<string, unknown>)?.[key] : data) as { _id?: unknown } | null;
  return String(row?._id ?? "");
};
const ok = (data?: unknown): Prechecked => ({ ok: true, data });
const asCheck = (outcome: RouteOutcome): Prechecked => (outcome.ok ? ok(outcome.data) : outcome);

async function memberName(id: unknown) {
  if (!Types.ObjectId.isValid(String(id))) return null;
  const row = await Member.findById(id).select("firstName lastName").lean();
  return row ? `${row.firstName} ${row.lastName}` : null;
}
const visibleMember = (a: Actor, input: RouteInput) =>
  callRoute(a, "GET /members/:id", { params: input.params ?? {} }).then(asCheck);

const booking: KindSpec = {
  route: "POST /appointments",
  editable: ["reasonDetail", "memberNote"],
  input: (args) => ({
    body: {
      ...pick(args, ["memberId", "serviceId", "providerId", "locationId", "startAt", "reason"]),
      ...pick(args, ["reasonDetail", "memberNote"]),
      bookingSource: "staff",
    },
  }),
  async precheck(a, input) {
    const {
      providerId: P,
      reason: R,
      reasonDetail: D,
      memberNote: N,
      bookingSource: S,
      ...q
    } = bodyOf(input);
    const quoted = await callRoute(a, "POST /appointments/quote", { body: q });
    if (!quoted.ok) return quoted;
    if ((quoted.data as { kind?: string }).kind === "episode")
      return {
        ok: false,
        status: 422,
        code: "BUNDLE_REQUIRES_EPISODE",
        message: "Bundles are booked as an assessment episode in the appointment screen",
      };
    return ok(quoted.data);
  },
  finalize(input, draftId, quoted) {
    const q = quoted as { finalCents: number | null; ruleVersion: string };
    return {
      body: {
        ...bodyOf(input),
        idempotencyKey: `alfred-${draftId}`,
        expectedQuote: { finalCents: q.finalCents, ruleVersion: q.ruleVersion },
      },
    };
  },
  async preview(input, quoted) {
    const b = bodyOf(input);
    const [service, provider, location] = await Promise.all([
      Service.findById(b["serviceId"]).select("title").lean(),
      StaffMember.findById(b["providerId"]).select("firstName lastName titlePrefix").lean(),
      Location.findById(b["locationId"]).select("name timeZone").lean(),
    ]);
    return {
      title: "Book appointment",
      memberName: await memberName(b["memberId"]),
      serviceTitle: service?.title ?? null,
      providerName: provider
        ? [provider.titlePrefix, provider.firstName, provider.lastName].filter(Boolean).join(" ")
        : null,
      locationName: location?.name ?? null,
      timeZone: location?.timeZone ?? null,
      startAt: new Date(String(b["startAt"])).toISOString(),
      reason: b["reason"] ?? null,
      priceCents: (quoted as { finalCents: number | null }).finalCents,
    };
  },
  resultOf: (data) => ({ targetType: "Appointment", targetId: idOf(data, "appointment") }),
};

const memberWrite = (
  route: string,
  keys: string[],
  editable: string[],
  title: string,
  targetType: string
): KindSpec => ({
  route,
  editable,
  input: (args) => ({ params: memberParam(args), body: pick(args, keys) }),
  precheck: visibleMember,
  preview: async (input) => ({
    title,
    memberName: await memberName(input.params?.["id"]),
    ...bodyOf(input),
  }),
  resultOf: (data) => ({ targetType, targetId: idOf(data) }),
});

const supplement: KindSpec = {
  route: "POST /members/:id/supplement-orders",
  editable: ["directions", "noteToMember"],
  input: (args) => ({
    params: memberParam(args),
    body: pick(args, [
      "productId",
      "directions",
      "durationDays",
      "qty",
      "fulfillment",
      "noteToMember",
    ]),
  }),
  async precheck(a, input) {
    const orders = await callRoute(a, "GET /members/:id/supplement-orders", {
      params: input.params ?? {},
    });
    if (!orders.ok) return orders;
    const products = await callRoute(a, "GET /supplement-products", {});
    if (!products.ok) return products;
    const product = (products.data as { items: { _id: unknown; priceCents: number }[] }).items.find(
      (p) => String(p._id) === String(bodyOf(input)["productId"])
    );
    return product
      ? ok(product)
      : { ok: false, status: 404, code: "PRODUCT_NOT_FOUND", message: "Product not found" };
  },
  async preview(input, product) {
    const b = bodyOf(input);
    const p = product as { name: string; brand?: string; priceCents: number };
    const qty = Number(b["qty"] ?? 1);
    return {
      title: "Draft supplement order",
      memberName: await memberName(input.params?.["id"]),
      productName: p.name,
      brand: p.brand ?? null,
      ...b,
      totalCents: p.priceCents * qty,
      fulfilment: "unconfigured",
    };
  },
  resultOf: (data) => ({ targetType: "SupplementOrder", targetId: idOf(data) }),
};

export const DRAFT_SPECS: Record<DraftKind, KindSpec> = {
  book_appointment: booking,
  add_note: memberWrite("POST /members/:id/notes", ["body"], ["body"], "Add note", "MemberNote"),
  create_flag: memberWrite(
    "POST /members/:id/flags",
    ["category", "title", "description", "severity"],
    ["title", "description"],
    "Create flag",
    "MemberFlag"
  ),
  request_pto: {
    route: "POST /staff/pto-requests",
    editable: ["note"],
    input: (args) => ({ body: pick(args, ["startDate", "endDate", "type", "note"]) }),
    precheck: () => Promise.resolve(ok()),
    preview: (input) => Promise.resolve({ title: "Request time off", ...bodyOf(input) }),
    resultOf: (data) => ({ targetType: "PtoRequest", targetId: idOf(data) }),
  },
  supplement_order: supplement,
};

export function draftView(row: InstanceType<typeof AlfredDraft>) {
  const spec = DRAFT_SPECS[row.kind as DraftKind];
  const body = bodyOf(row.input as RouteInput);
  return {
    id: String(row._id),
    kind: row.kind,
    status: row.status,
    preview: row.preview,
    editable: Object.fromEntries(spec.editable.map((k) => [k, str(body[k]) ?? ""])),
    lastError: row.lastError,
    result: row.result,
    createdAt: row.createdAt,
  };
}

/**
 * Validate a proposal as the acting staff member and store it as a pending draft.
 * Returns what the model may see: the server-assigned id and the server preview.
 */
export async function proposeDraft(
  a: Actor,
  kind: DraftKind,
  args: Args,
  conversationId: string | null
): Promise<RouteOutcome> {
  const spec = DRAFT_SPECS[kind];
  const input = spec.input(args);
  const prepared = await prepareRoute(a, spec.route, input);
  if (!("req" in prepared)) return prepared;
  const validated: RouteInput = { params: prepared.req.params, body: prepared.req.body };
  const checked = await spec.precheck(a, validated);
  if (!checked.ok) return checked;
  const Id = new Types.ObjectId();
  const stored = spec.finalize?.(validated, String(Id), checked.data) ?? validated;
  const row = await AlfredDraft.create({
    _id: Id,
    organizationId: a.staff.organizationId,
    staffId: a.staff._id,
    conversationId,
    kind,
    memberId: Types.ObjectId.isValid(String(stored.params?.["id"] ?? bodyOf(stored)["memberId"]))
      ? (stored.params?.["id"] ?? bodyOf(stored)["memberId"])
      : null,
    input: JSON.parse(JSON.stringify(stored)),
    preview: await spec.preview(stored, checked.data),
  });
  return { ok: true, data: draftView(row) };
}

const mine = (req: Request) => ({
  _id: req.params["draftId"],
  organizationId: actor(req).organizationId,
  staffId: actor(req)._id,
});

export async function getDraft(req: Request) {
  const row = await AlfredDraft.findOne(mine(req));
  if (!row) throw new NotFoundError("Draft not found", "DRAFT_NOT_FOUND");
  return draftView(row);
}

function withEdits(input: RouteInput, edits: Record<string, string>, editable: string[]) {
  const refused = Object.keys(edits).filter((k) => !editable.includes(k));
  if (refused.length)
    throw new AppError("These fields cannot be edited", 422, true, refused, "FIELD_NOT_EDITABLE");
  return { ...input, body: { ...bodyOf(input), ...edits } };
}

/** Claim, execute through the normal route as the confirming staff member, record. */
export async function confirmDraft(req: Request) {
  const staff = actor(req);
  const edits = (req.body as { edits?: Record<string, string> }).edits ?? {};
  const existing = await AlfredDraft.findOne(mine(req));
  if (!existing) throw new NotFoundError("Draft not found", "DRAFT_NOT_FOUND");
  const spec = DRAFT_SPECS[existing.kind as DraftKind];
  const input = withEdits(existing.input as RouteInput, edits, spec.editable);
  // ponytail: a crash between claim and write leaves the draft "confirming"; re-draft to retry.
  const claimed = await AlfredDraft.findOneAndUpdate(
    { ...mine(req), status: "pending" },
    { $set: { status: "confirming" } },
    { new: true }
  );
  if (!claimed)
    throw new ConflictError("This draft was already decided", undefined, "DRAFT_DECIDED");
  const outcome = await callRoute({ staff, requestId: req.requestId }, spec.route, input);
  if (!outcome.ok) {
    await AlfredDraft.updateOne(
      { _id: claimed._id, status: "confirming" },
      { $set: { status: "pending", lastError: outcome.code } }
    );
    throw new AppError(outcome.message, outcome.status, true, outcome.issues, outcome.code);
  }
  const done = await AlfredDraft.findOneAndUpdate(
    { _id: claimed._id, status: "confirming" },
    {
      $set: {
        status: "confirmed",
        input,
        lastError: null,
        result: spec.resultOf(outcome.data),
        decidedAt: new Date(),
      },
    },
    { new: true }
  );
  if (!done) throw new Error("Draft state lost");
  return draftView(done);
}

export async function cancelDraft(req: Request) {
  const row = await AlfredDraft.findOneAndUpdate(
    { ...mine(req), status: "pending" },
    { $set: { status: "cancelled", decidedAt: new Date() } },
    { new: true }
  );
  if (row) return draftView(row);
  if (await AlfredDraft.exists(mine(req)))
    throw new ConflictError("This draft was already decided", undefined, "DRAFT_DECIDED");
  throw new NotFoundError("Draft not found", "DRAFT_NOT_FOUND");
}
