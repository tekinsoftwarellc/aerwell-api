import type { Request } from "express";
import type { ClientSession } from "mongoose";
import { BadRequestError, ConflictError, NotFoundError } from "../../common/errors/AppError.js";
import type { MemberDocument } from "../member/member.model.js";
import { organizationToday } from "../schedule/flags.js";
import {
  actorId,
  assertStaff,
  auditRead,
  auditedWrite,
  byMember,
  clinicalMember,
  staffNames,
} from "./clinical.shared.js";
import { InjectionLog, Protocol, ProtocolRevision } from "./protocol.model.js";

const DAY = 86400000;
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);
/** Calendar progress only (dates are clinician-entered); no clinical inference. */
export function progress(startDate: string, estEndDate: string, today: string) {
  const total = Math.max(days(startDate, estEndDate), 1);
  const elapsed = Math.min(Math.max(days(startDate, today), 0), total);
  const durationWeeks = Math.ceil(total / 7);
  return {
    durationWeeks,
    currentWeek:
      days(startDate, today) < 0 ? 0 : Math.min(Math.floor(elapsed / 7) + 1, durationWeeks),
    percentComplete: Math.round((elapsed / total) * 100),
  };
}
type ProtocolRow = Awaited<ReturnType<typeof protocolOf>>;
function present(row: ProtocolRow, today: string, names: Map<string, string>) {
  const plain = "toObject" in row ? row.toObject() : row;
  return {
    ...plain,
    prescribingProviderName: names.get(String(plain.prescribingProviderId)) ?? null,
    ...progress(plain.startDate, plain.estEndDate, today),
  };
}
async function protocolOf(member: MemberDocument, protocolId: unknown, session?: ClientSession) {
  const row = await Protocol.findOne({ ...byMember(member), _id: protocolId }).session(
    session ?? null
  );
  if (!row) throw new NotFoundError("Protocol not found");
  return row;
}
async function presentAll(member: MemberDocument, rows: ProtocolRow[]) {
  const today = await organizationToday(member.organizationId);
  const names = await staffNames(rows.map((r) => r.prescribingProviderId));
  return rows.map((r) => present(r, today, names));
}

export async function listProtocols(req: Request) {
  const member = await clinicalMember(req, "PROTOCOLS");
  const status = req.query["status"];
  const rows = await Protocol.find({ ...byMember(member), ...(status === "all" ? {} : { status }) })
    .sort({ startDate: -1, _id: -1 })
    .limit(200);
  await auditRead(req, "Protocols", member);
  return presentAll(member, rows);
}
export async function getProtocol(req: Request) {
  const member = await clinicalMember(req, "PROTOCOLS");
  const row = await protocolOf(member, req.params["protocolId"]);
  await auditRead(req, "Protocol", member, String(row._id));
  return (await presentAll(member, [row]))[0];
}
export async function createProtocol(req: Request) {
  const member = await clinicalMember(req, "PROTOCOLS", true);
  await assertStaff(member.organizationId, req.body.prescribingProviderId);
  const row = await auditedWrite(
    req,
    member,
    { action: "created", targetType: "Protocol" },
    async (session) => {
      const [created] = await Protocol.create(
        [{ ...req.body, ...byMember(member), createdById: actorId(req) }],
        { session }
      );
      if (!created) throw new Error("Protocol was not created");
      return created;
    }
  );
  return (await presentAll(member, [row]))[0];
}

const EDITABLE = [
  "prescribingProviderId",
  "startDate",
  "estEndDate",
  "description",
  "items",
  "supplyRemainingDays",
  "nextRefillDue",
  "lastInjectionSite",
] as const;
const snapshot = (row: ProtocolRow) => {
  const plain = row.toObject() as Record<string, unknown>;
  return Object.fromEntries(EDITABLE.map((k) => [k, plain[k] ?? null]));
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function activeOnly(row: ProtocolRow) {
  if (row.status !== "active")
    throw new ConflictError("Only an active protocol can change", undefined, "PROTOCOL_NOT_ACTIVE");
}
function expectVersion(row: ProtocolRow, expected: number) {
  if (row.get("version") !== expected)
    throw new ConflictError(
      "This protocol changed since you opened it",
      undefined,
      "VERSION_CONFLICT"
    );
}
async function writeRevision(
  req: Request,
  row: ProtocolRow,
  action: "adjusted" | "discontinued" | "completed",
  before: object,
  session: ClientSession,
  reason?: string
) {
  await ProtocolRevision.create(
    [
      {
        organizationId: row.organizationId,
        protocolId: row._id,
        memberId: row.memberId,
        changedById: actorId(req),
        action,
        before,
        after: action === "adjusted" ? snapshot(row) : { status: row.status },
        reason,
      },
    ],
    { session }
  );
}

/** Save Changes: the revision is written in the same transaction, only when something moved. */
export async function patchProtocol(req: Request) {
  const member = await clinicalMember(req, "PROTOCOLS", true);
  const { expectedVersion, reason, ...fields } = req.body;
  if (fields.prescribingProviderId)
    await assertStaff(member.organizationId, fields.prescribingProviderId);
  const row = await auditedWrite(
    req,
    member,
    { action: "updated", targetType: "Protocol" },
    async (session) => {
      const doc = await protocolOf(member, req.params["protocolId"], session);
      activeOnly(doc);
      expectVersion(doc, expectedVersion);
      const before = snapshot(doc);
      doc.set(fields);
      if (doc.startDate > doc.estEndDate)
        throw new BadRequestError("End date must not precede start", undefined, "INVALID_DATES");
      if (same(before, snapshot(doc))) return doc;
      doc.increment();
      await doc.save({ session });
      await writeRevision(req, doc, "adjusted", before, session, reason);
      return doc;
    }
  );
  return (await presentAll(member, [row]))[0];
}

function endProtocol(status: "discontinued" | "completed") {
  return async (req: Request) => {
    const member = await clinicalMember(req, "PROTOCOLS", true);
    const row = await auditedWrite(
      req,
      member,
      { action: status, targetType: "Protocol" },
      async (session) => {
        // Conditional claim: an ended protocol can never be ended twice.
        const doc = await Protocol.findOneAndUpdate(
          { ...byMember(member), _id: req.params["protocolId"], status: "active" },
          {
            $set: {
              status,
              endedAt: new Date(),
              ...(req.body.reason ? { discontinuedReason: req.body.reason } : {}),
            },
            $inc: { version: 1 },
          },
          { new: true, session }
        );
        if (!doc) {
          await protocolOf(member, req.params["protocolId"], session);
          throw new ConflictError(
            "Only an active protocol can change",
            undefined,
            "PROTOCOL_NOT_ACTIVE"
          );
        }
        await writeRevision(req, doc, status, { status: "active" }, session, req.body.reason);
        return doc;
      }
    );
    return (await presentAll(member, [row]))[0];
  };
}
export const discontinueProtocol = endProtocol("discontinued");
export const completeProtocol = endProtocol("completed");

export async function listRevisions(req: Request) {
  const member = await clinicalMember(req, "PROTOCOLS");
  const row = await protocolOf(member, req.params["protocolId"]);
  const rows = await ProtocolRevision.find({
    protocolId: row._id,
    organizationId: member.organizationId,
  })
    .sort({ changedAt: -1, _id: -1 })
    .lean();
  const names = await staffNames(rows.map((r) => r.changedById));
  await auditRead(req, "ProtocolRevisions", member, String(row._id));
  return rows.map((r) => ({ ...r, changedByName: names.get(String(r.changedById)) ?? null }));
}

export async function logInjection(req: Request) {
  const member = await clinicalMember(req, "PROTOCOLS", true);
  const { itemId, administeredAt, site } = req.body;
  return auditedWrite(
    req,
    member,
    { action: "created", targetType: "InjectionLog" },
    async (session) => {
      const doc = await protocolOf(member, req.params["protocolId"], session);
      activeOnly(doc);
      if (!doc.items.some((i) => String(i._id) === itemId))
        throw new NotFoundError("Compound not found on this protocol");
      const at = new Date(administeredAt);
      const [log] = await InjectionLog.create(
        [
          {
            organizationId: member.organizationId,
            protocolId: doc._id,
            memberId: member._id,
            itemId,
            administeredAt: at,
            site,
            loggedById: actorId(req),
          },
        ],
        { session }
      );
      if (!log) throw new Error("Injection was not logged");
      // Only a newer injection moves "Last Logged Injection"; back-filled ones do not.
      await Protocol.updateOne(
        {
          _id: doc._id,
          $or: [{ lastLoggedInjectionAt: null }, { lastLoggedInjectionAt: { $lt: at } }],
        },
        { $set: { lastLoggedInjectionAt: at, lastInjectionSite: site } },
        { session }
      );
      return log;
    }
  );
}
