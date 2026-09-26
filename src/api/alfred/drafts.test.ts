import { Types } from "mongoose";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  alfredWorld,
  resetModels,
  textTurn,
  toolTurn,
  useModel,
} from "../../test/alfredFixture.js";
import { DAY, at, pinClock } from "../../test/appointmentFixture.js";
import { Appointment } from "../appointment/appointment.model.js";
import { AuditEvent } from "../audit/audit.js";
import { MemberFlag, MemberNote } from "../member/member.model.js";
import { PtoRequest } from "../schedule/schedule.model.js";
import { StaffMember } from "../staff/staff.model.js";
import {
  SupplementOrder,
  SupplementProduct,
  seedSupplementCatalog,
} from "../supplement/supplement.js";
import { AlfredDraft } from "./alfred.model.js";

beforeEach(() => pinClock());
afterEach(() => {
  resetModels();
  vi.useRealTimers();
});

type World = Awaited<ReturnType<typeof alfredWorld>>;
type Api = ReturnType<World["http"]>;
/** One chat turn in which the model calls a single propose_* tool. */
async function propose(api: Api, tool: string, input: Record<string, unknown>) {
  const model = useModel("smart", [
    toolTurn({ name: tool, input }),
    textTurn("A draft is ready for your review."),
  ]);
  const convo = await api.post("/api/v1/alfred/conversations");
  const res = await api.post(`/api/v1/alfred/conversations/${convo.body.data.id}/messages`, {
    text: "please",
  });
  expect(res.status).toBe(200);
  return { drafts: res.body.data.messages[1].drafts, result: model.toolResults()[0] ?? {} };
}
const bookingArgs = (w: World, extra: object = {}) => ({
  memberId: w.memberId,
  serviceId: w.service("clinician-telehealth-visit"),
  providerId: String(w.provider.staff._id),
  locationId: String(w.vegas._id),
  startAt: at(DAY, "09:00").toISOString(),
  reason: "new_concern",
  ...extra,
});
const draftPath = (id: string, action = "") => `/api/v1/alfred/drafts/${id}${action}`;

it("a booking is only a draft until confirmed; confirm books once through the normal path", async () => {
  const w = await alfredWorld();
  const api = w.http(w.director.accessToken);
  const { drafts } = await propose(api, "propose_book_appointment", {
    ...bookingArgs(w),
    idempotencyKey: "model-chosen-key",
    id: "000000000000000000000abc",
    memberName: "Someone Else",
  });
  expect(drafts).toHaveLength(1);
  const [draft] = drafts;
  // Server id, server preview (DB names, the quoted price), and nothing booked yet.
  expect(draft.id).not.toBe("000000000000000000000abc");
  expect(draft).toMatchObject({
    kind: "book_appointment",
    status: "pending",
    preview: {
      memberName: "Shannon Ashton",
      providerName: "Dr. Philip Diebel",
      locationName: "Aerwell Las Vegas",
    },
    editable: { reasonDetail: "", memberNote: "" },
  });
  expect(draft.preview.reason).toBe("new_concern");
  expect(draft.preview.serviceTitle).toEqual(expect.any(String));
  expect(await Appointment.countDocuments()).toBe(0);
  const stored = await AlfredDraft.findById(draft.id).lean();
  expect((stored?.input as { body: { idempotencyKey: string } }).body.idempotencyKey).toBe(
    `alfred-${draft.id}`
  );

  const confirmed = await api.post(draftPath(draft.id, "/confirm"), {
    edits: { reasonDetail: "Follow-up on fatigue" },
  });
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.data).toMatchObject({
    status: "confirmed",
    result: { targetType: "Appointment" },
  });
  const appt = await Appointment.findById(confirmed.body.data.result.targetId).lean();
  expect(appt).toMatchObject({
    reasonDetail: "Follow-up on fatigue",
    bookingSource: "staff",
    idempotencyKey: `alfred-${draft.id}`,
  });
  expect(
    await AuditEvent.countDocuments({
      targetType: "Appointment",
      actorId: String(w.director.staff._id),
    })
  ).toBeGreaterThan(0);
  // A double confirm never books twice.
  const again = await api.post(draftPath(draft.id, "/confirm"));
  expect(again.status).toBe(409);
  expect(again.body.code).toBe("DRAFT_DECIDED");
  expect(await Appointment.countDocuments()).toBe(1);
});

it("confirm re-checks permissions as the confirming staff member and keeps the draft on refusal", async () => {
  const w = await alfredWorld();
  const api = w.http(w.director.accessToken);
  const { drafts } = await propose(api, "propose_book_appointment", bookingArgs(w));
  await StaffMember.updateOne(
    { _id: w.director.staff._id },
    { $set: { permissionOverrides: [{ module: "APPOINTMENTS", level: "view", scope: "all" }] } }
  );
  const refused = await api.post(draftPath(drafts[0].id, "/confirm"));
  expect(refused.status).toBe(403);
  expect(await Appointment.countDocuments()).toBe(0);
  expect(await AlfredDraft.findById(drafts[0].id).lean()).toMatchObject({
    status: "pending",
    lastError: "FORBIDDEN",
  });
  // Only the owner can see, confirm or cancel it.
  const other = w.http(w.nurseOwn.accessToken);
  expect((await other.get(draftPath(drafts[0].id))).status).toBe(404);
  expect((await other.post(draftPath(drafts[0].id, "/confirm"))).status).toBe(404);
  expect((await other.post(draftPath(drafts[0].id, "/cancel"))).status).toBe(404);
  expect((await api.post(draftPath(drafts[0].id, "/cancel"))).body.data.status).toBe("cancelled");
  expect((await api.post(draftPath(drafts[0].id, "/cancel"))).body.code).toBe("DRAFT_DECIDED");
});

it("a proposal the staff member could not make over HTTP is refused and creates no draft", async () => {
  const w = await alfredWorld();
  const fd = await propose(w.http(w.frontDesk.accessToken), "propose_add_note", {
    memberId: w.memberId,
    body: "x",
  });
  expect(fd.result).toEqual({ error: expect.objectContaining({ status: 403 }) });
  const own = await propose(w.http(w.nurseOwn.accessToken), "propose_create_flag", {
    memberId: w.memberId,
    category: "clinical",
    title: "Check",
  });
  expect(own.result).toEqual({ error: expect.objectContaining({ status: 404 }) });
  const bad = await propose(
    w.http(w.director.accessToken),
    "propose_book_appointment",
    bookingArgs(w, { startAt: "soon" })
  );
  expect(bad.result).toEqual({
    error: expect.objectContaining({ status: 400, code: "VALIDATION_ERROR" }),
  });
  expect(await AlfredDraft.countDocuments()).toBe(0);
});

it("note, flag and time-off drafts write through their own routes with only whitelisted edits", async () => {
  const w = await alfredWorld();
  const api = w.http(w.director.accessToken);
  const note = (
    await propose(api, "propose_add_note", { memberId: w.memberId, body: "Reports fatigue" })
  ).drafts[0];
  expect(note.preview).toMatchObject({ memberName: "Shannon Ashton", body: "Reports fatigue" });
  const refused = await api.post(draftPath(note.id, "/confirm"), {
    edits: { appointmentId: "000000000000000000000001" },
  });
  expect(refused.body.code).toBe("FIELD_NOT_EDITABLE");
  expect(await MemberNote.countDocuments()).toBe(0);
  await api.post(draftPath(note.id, "/confirm"), { edits: { body: "Reports fatigue, edited" } });
  expect(await MemberNote.findOne().lean()).toMatchObject({ body: "Reports fatigue, edited" });

  const flag = (
    await propose(api, "propose_create_flag", {
      memberId: w.memberId,
      category: "clinical",
      title: "Recheck TSH",
      severity: "urgent",
    })
  ).drafts[0];
  expect(await MemberFlag.countDocuments({ title: "Recheck TSH" })).toBe(0);
  expect((await api.post(draftPath(flag.id, "/confirm"))).status).toBe(200);
  expect(await MemberFlag.findOne({ title: "Recheck TSH" }).lean()).toMatchObject({
    severity: "urgent",
  });

  const pto = (
    await propose(api, "propose_request_pto", {
      startDate: "2027-03-20",
      endDate: "2027-03-21",
      type: "vacation",
    })
  ).drafts[0];
  expect(await PtoRequest.countDocuments()).toBe(0);
  const ok = await api.post(draftPath(pto.id, "/confirm"));
  expect(ok.body.data.result.targetType).toBe("PtoRequest");
  expect(await PtoRequest.findOne().lean()).toMatchObject({
    staffId: w.director.staff._id,
    status: "pending",
  });
});

it("a supplement order is a draft record only: priced from the catalog, never placed", async () => {
  const w = await alfredWorld();
  await seedSupplementCatalog("org-test");
  const product = await SupplementProduct.findOne({ sku: "vit-d3-k2-10000" }).lean();
  const api = w.http(w.director.accessToken);
  const args = {
    memberId: w.memberId,
    productId: String(product?._id),
    directions: "1 capsule daily with breakfast",
    durationDays: 60,
    qty: 2,
    fulfillment: "ship",
  };
  const missing = await propose(api, "propose_supplement_order", {
    ...args,
    productId: "000000000000000000000001",
  });
  expect(missing.result).toEqual({ error: expect.objectContaining({ code: "PRODUCT_NOT_FOUND" }) });
  const draft = (await propose(api, "propose_supplement_order", { ...args, autoRefill: true }))
    .drafts[0];
  expect(draft.preview).toMatchObject({
    productName: "Vitamin D3 + K2 10,000 IU",
    totalCents: 6800,
    fulfilment: "unconfigured",
  });
  expect(await SupplementOrder.countDocuments()).toBe(0);
  await api.post(draftPath(draft.id, "/confirm"));
  expect(await SupplementOrder.findOne().lean()).toMatchObject({
    status: "draft",
    qty: 2,
    pricing: { subtotalCents: 6800, totalCents: 6800 },
    prescribedById: w.director.staff._id,
    autoRefill: false,
  });
  const fd = await propose(w.http(w.frontDesk.accessToken), "propose_supplement_order", args);
  expect(fd.result).toEqual({ error: expect.objectContaining({ status: 403 }) });
});

it("W11: an own-scope booker proposing another provider is refused at propose, not at confirm", async () => {
  const w = await alfredWorld();
  const { Member } = await import("../member/member.model.js");
  await Member.updateOne(
    { _id: w.memberId },
    { $push: { assignedClinicianIds: w.nurseOwn.staff._id } }
  );
  const own = await propose(
    w.http(w.nurseOwn.accessToken),
    "propose_book_appointment",
    bookingArgs(w)
  );
  expect(own.result).toEqual({ error: expect.objectContaining({ status: 403 }) });
  expect(await AlfredDraft.countDocuments()).toBe(0);
});

it("W11: a booking draft stuck in confirming (crash after claim) can be confirmed again, booking once", async () => {
  const w = await alfredWorld();
  const api = w.http(w.director.accessToken);
  const [draft] = (await propose(api, "propose_book_appointment", bookingArgs(w))).drafts;
  // The crashed attempt had already written the appointment with the draft's key.
  const stored = await AlfredDraft.findById(draft.id).lean();
  const input = stored?.input as { body: Record<string, unknown> };
  expect((await api.post("/api/v1/appointments", input.body)).status).toBe(201);
  await AlfredDraft.updateOne(
    { _id: draft.id },
    { status: "confirming", confirmingAt: new Date() }
  );
  // A live claim is still refused…
  expect((await api.post(draftPath(draft.id, "/confirm"))).body.code).toBe("DRAFT_DECIDED");
  // …but once it is stale the idempotency key makes a retry safe.
  await AlfredDraft.updateOne(
    { _id: draft.id },
    { confirmingAt: new Date(Date.now() - 10 * 60_000) }
  );
  const retried = await api.post(draftPath(draft.id, "/confirm"));
  expect(retried.status).toBe(200);
  expect(retried.body.data.status).toBe("confirmed");
  expect(await Appointment.countDocuments()).toBe(1);
  expect(retried.body.data.result.targetId).toBe(String((await Appointment.findOne())?._id));
});

it("W11: a stuck non-idempotent draft is never re-run blindly; the staff member can cancel it", async () => {
  const w = await alfredWorld();
  const api = w.http(w.director.accessToken);
  const [note] = (await propose(api, "propose_add_note", { memberId: w.memberId, body: "Stuck" }))
    .drafts;
  await AlfredDraft.updateOne(
    { _id: note.id },
    { status: "confirming", confirmingAt: new Date(Date.now() - 10 * 60_000) }
  );
  const retried = await api.post(draftPath(note.id, "/confirm"));
  expect(retried.status).toBe(409);
  expect(retried.body.code).toBe("DRAFT_OUTCOME_UNKNOWN");
  expect(await MemberNote.countDocuments()).toBe(0);
  const cancelled = await api.post(draftPath(note.id, "/cancel"));
  expect(cancelled.status).toBe(200);
  expect(cancelled.body.data.status).toBe("cancelled");
  // A draft stuck before W11 has no confirmingAt at all: it is stale too.
  const [old] = (await propose(api, "propose_add_note", { memberId: w.memberId, body: "Older" }))
    .drafts;
  await AlfredDraft.collection.updateOne(
    { _id: new Types.ObjectId(old.id) },
    { $set: { status: "confirming" }, $unset: { confirmingAt: "" } }
  );
  expect((await api.post(draftPath(old.id, "/cancel"))).status).toBe(200);
});
