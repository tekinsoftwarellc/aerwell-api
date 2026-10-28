import mongoose from "mongoose";
import { ERASURE_MAP, type ErasureEntry } from "./erase-member.map.js";

// `node dist/scripts/erase-member.js <accountId>` is a DRY RUN (default): counts and blockers.
// `node dist/scripts/erase-member.js --confirm <accountId>` writes.
//
// Member erasure for Aerwell (decision 4A). `<accountId>` is the ALFRED account id; members are
// matched through `Member.alfredAccountId`. Only when nothing matches is `<id>` treated as an
// Aerwell `Member._id` (an unlinked member). Output is ids and counts only, never values.
// Runbook: docs/operations/member-erasure-runbook.md.
//
// CLINICAL RECORDS ARE NOT ERASED. Nevada NRS 629.051 (five-year retention) conflicts with the
// signed keep-list; until counsel rules, clinical rows are kept and marked `erasureRetainedAt`,
// and a member who has any is archived and marked too, with identity left intact (a retained
// record must still say whose it is). A member without clinical rows is pseudonymised.
//
// Order: erase content, scrub kept rows, mark retained, member last, one audit row. A failed
// run is retried with the same command; a second run reports zeroes. Raw collections.

type Doc = mongoose.mongo.Document;
type Filter = mongoose.mongo.Filter<Doc>;
type Oid = mongoose.Types.ObjectId;

export interface EraseResult {
  members: string[];
  matchedBy: "alfredAccountId" | "_id";
  counts: Record<string, number>;
  blockers: string[];
  /** The member photo object, if the member is pseudonymised: remove with `aws s3 rm`. */
  s3Keys: string[];
  clinicalRetained: boolean;
}
interface Ctx {
  alfredId: string | undefined;
  memberIds: Oid[];
  now: Date;
}

const LEASE_STALE_MS = 45_000; // as src/api/visit/visit.service.ts
const OPEN_APPOINTMENT = ["booked", "confirmed", "checked_in", "in_progress"];
const MEMBER_UNSET = [
  "lastName",
  "email",
  "phone",
  "dateOfBirth",
  "sex",
  "address",
  "emergencyContact",
  "intakeNote",
  "photoUploadId",
];

/** A retained clinical record must still say whose it is: only these identify the person. */
const RETAIN_KEEP = ["lastName", "dateOfBirth", "sex"];
const RETAIN_UNSET = MEMBER_UNSET.filter((f) => !RETAIN_KEEP.includes(f));

export class EraseBlocked extends Error {
  readonly code = "ERASE_BLOCKED";
  constructor(readonly blockers: string[]) {
    super("ERASE_BLOCKED");
  }
}

function coll(target: ErasureEntry | string) {
  const db = mongoose.connection.db;
  if (!db) throw new Error("database not connected");
  return db.collection(typeof target === "string" ? target : target.collection);
}

// memberId is an ObjectId in most collections and a string in auditevents: match both.
const memberKeys = (ctx: Ctx): (Oid | string)[] => [...ctx.memberIds, ...ctx.memberIds.map(String)];
const accountKeys = (ctx: Ctx): string[] => [
  ...(ctx.alfredId ? [ctx.alfredId] : []),
  ...ctx.memberIds.map(String),
];

function entryFilter(e: ErasureEntry, ctx: Ctx): Filter {
  const or: Filter[] = e.by.map((f) =>
    f === "accountId" ? { accountId: { $in: accountKeys(ctx) } } : { [f]: { $in: memberKeys(ctx) } }
  );
  return or.length === 1 && or[0] ? or[0] : { $or: or };
}

async function resolveMembers(
  id: Oid
): Promise<{ docs: Doc[]; matchedBy: EraseResult["matchedBy"] }> {
  const linked = await coll("members")
    .find({ alfredAccountId: String(id) })
    .toArray();
  if (linked.length) return { docs: linked, matchedBy: "alfredAccountId" };
  const own = await coll("members").find({ _id: id }).toArray();
  if (!own.length) throw new Error("member not found");
  return { docs: own, matchedBy: "_id" };
}

export async function findBlockers(ctx: Ctx): Promise<string[]> {
  const mine = { memberId: { $in: ctx.memberIds } };
  const appts = await coll("appointments").find(mine).project({ _id: 1 }).toArray();
  const probes: [string, string, Filter][] = [
    [
      "appointments:future",
      "appointments",
      {
        ...mine,
        $or: [
          { status: "in_progress" },
          { status: { $in: OPEN_APPOINTMENT }, startAt: { $gt: ctx.now } },
        ],
      },
    ],
    [
      "memberships:active",
      "membermemberships",
      { ...mine, status: { $in: ["active", "past_due", "paused"] } },
    ],
    [
      "product_orders:open",
      "productorders",
      { memberId: { $in: ctx.memberIds }, status: { $in: ["placed", "paid", "shipped"] } },
    ],
    [
      "partner_outbox:pending",
      "partner_outbox",
      { accountId: { $in: accountKeys(ctx) }, status: { $in: ["pending", "sending", "failed"] } },
    ],
    [
      "capture_lease:live",
      "visitcaptureleases",
      {
        _id: { $in: appts.map((a) => a["_id"]) },
        captureId: { $ne: null },
        heartbeatAt: { $gt: new Date(ctx.now.getTime() - LEASE_STALE_MS) },
      },
    ],
  ];
  const out: string[] = [];
  for (const [label, name, filter] of probes) {
    const n = await coll(name).countDocuments(filter);
    if (n > 0) out.push(`${label}=${n}`);
  }
  return out;
}

async function countByClass(cls: string, ctx: Ctx): Promise<number> {
  let total = 0;
  for (const e of Object.values(ERASURE_MAP)) {
    if (e.class === cls) total += await coll(e).countDocuments(entryFilter(e, ctx));
  }
  return total;
}

async function eraseOne(e: ErasureEntry, ctx: Ctx, confirm: boolean): Promise<number> {
  const filter = entryFilter(e, ctx);
  if (!confirm) return coll(e).countDocuments(filter);
  return (await coll(e).deleteMany(filter)).deletedCount;
}

async function scrubOne(e: ErasureEntry, ctx: Ctx, confirm: boolean): Promise<number> {
  const scrub = e.scrub;
  if (!scrub) return 0;
  const present = scrub.to ? { $exists: true, $ne: scrub.to } : { $exists: true };
  const filter: Filter = { $and: [entryFilter(e, ctx), { [scrub.path]: present }] };
  if (!confirm) return coll(e).countDocuments(filter);
  const update = scrub.to ? { $set: { [scrub.path]: scrub.to } } : { $unset: { [scrub.path]: "" } };
  return (await coll(e).updateMany(filter, update)).modifiedCount;
}

async function markRetained(e: ErasureEntry, ctx: Ctx, confirm: boolean): Promise<number> {
  const filter: Filter = { $and: [entryFilter(e, ctx), { erasureRetainedAt: { $exists: false } }] };
  if (!confirm) return coll(e).countDocuments(filter);
  return (await coll(e).updateMany(filter, { $set: { erasureRetainedAt: ctx.now } })).modifiedCount;
}

const pseudonymPending = (ids: Oid[]): Filter => ({
  _id: { $in: ids },
  $or: [
    { firstName: { $ne: "Erased" } },
    { archivedAt: null },
    ...MEMBER_UNSET.map((f) => ({ [f]: { $exists: true } })),
  ],
});

async function photoKeys(docs: Doc[]): Promise<string[]> {
  const ids = docs.map((d) => d["photoUploadId"]).filter((x) => x !== undefined && x !== null);
  const rows = await coll("uploadrecords")
    .find({ _id: { $in: ids } })
    .project({ key: 1 })
    .toArray();
  return rows.map((r) => r["key"]).filter((k): k is string => typeof k === "string");
}

/** Pseudonymise a member with no clinical rows. authAccount, org and processor customer stay. */
async function pseudonymise(
  docs: Doc[],
  ctx: Ctx,
  confirm: boolean
): Promise<Record<string, number>> {
  const filter = pseudonymPending(ctx.memberIds);
  if (!confirm) return { members: await coll("members").countDocuments(filter) };
  const unset = Object.fromEntries(MEMBER_UNSET.map((f) => [f, ""]));
  const m = await coll("members").updateMany(filter, {
    $set: { firstName: "Erased", archivedAt: ctx.now },
    $unset: unset,
  });
  const photoIds = docs.map((d) => d["photoUploadId"]).filter((x) => x !== undefined && x !== null);
  const u = await coll("uploadrecords").deleteMany({ _id: { $in: photoIds } });
  return { members: m.modifiedCount, uploadrecords: u.deletedCount };
}

/** A member with clinical rows is archived and marked; only name, DOB and sex stay with the record. */
async function retainMember(
  docs: Doc[],
  ctx: Ctx,
  confirm: boolean
): Promise<Record<string, number>> {
  const filter: Filter = {
    _id: { $in: ctx.memberIds },
    $or: [
      { erasureRetainedAt: { $exists: false } },
      ...RETAIN_UNSET.map((f) => ({ [f]: { $exists: true } })),
    ],
  };
  if (!confirm) return { "members.retained": await coll("members").countDocuments(filter) };
  const m = await coll("members").updateMany(filter, {
    $set: { archivedAt: ctx.now, erasureRetainedAt: ctx.now },
    $unset: Object.fromEntries(RETAIN_UNSET.map((f) => [f, ""])),
  });
  const photoIds = docs.map((d) => d["photoUploadId"]).filter((x) => x !== undefined && x !== null);
  const u = await coll("uploadrecords").deleteMany({ _id: { $in: photoIds } });
  return { "members.retained": m.modifiedCount, uploadrecords: u.deletedCount };
}

async function writeAudit(docs: Doc[], ctx: Ctx): Promise<void> {
  const rows = docs.map((d) => ({
    organizationId: d["organizationId"],
    actorId: "script:erase-member",
    action: "member.erase",
    targetType: "member",
    targetId: String(d["_id"]),
    memberId: String(d["_id"]),
    occurredAt: ctx.now,
  }));
  await coll("auditevents").insertMany(rows);
}

async function eraseAll(docs: Doc[], ctx: Ctx, confirm: boolean, clinical: boolean) {
  const counts: Record<string, number> = {};
  for (const e of Object.values(ERASURE_MAP)) {
    if (e.class === "erase") counts[e.collection] = await eraseOne(e, ctx, confirm);
    if (e.scrub) counts[`${e.collection}.${e.scrub.path}`] = await scrubOne(e, ctx, confirm);
    if (e.class === "keep:clinical")
      counts[`${e.collection}.retained`] = await markRetained(e, ctx, confirm);
  }
  const member = clinical
    ? await retainMember(docs, ctx, confirm)
    : await pseudonymise(docs, ctx, confirm);
  return { ...counts, ...member };
}

export async function eraseMember(
  accountId: string,
  opts: { confirm: boolean }
): Promise<EraseResult> {
  const id = new mongoose.Types.ObjectId(accountId);
  const { docs, matchedBy } = await resolveMembers(id);
  const alfredLink = docs[0]?.["alfredAccountId"];
  const ctx: Ctx = {
    alfredId:
      matchedBy === "alfredAccountId"
        ? String(id)
        : typeof alfredLink === "string"
          ? alfredLink
          : undefined,
    memberIds: docs.map((d) => d["_id"] as Oid),
    now: new Date(),
  };
  const blockers = await findBlockers(ctx);
  if (opts.confirm && blockers.length) throw new EraseBlocked(blockers);

  const clinical = (await countByClass("keep:clinical", ctx)) > 0;
  const s3Keys = await photoKeys(docs);
  const counts = await eraseAll(docs, ctx, opts.confirm, clinical);
  // No audit row on an idempotent re-run (nothing changed).
  if (opts.confirm && Object.values(counts).some((n) => n > 0)) await writeAudit(docs, ctx);
  return {
    members: ctx.memberIds.map(String),
    matchedBy,
    counts,
    blockers,
    s3Keys,
    clinicalRetained: clinical,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const id = args.find((a) => !a.startsWith("--"));
  if (!(id && /^[0-9a-f]{24}$/i.test(id))) {
    console.error("usage: erase-member [--confirm] <alfredAccountId>");
    process.exitCode = 1;
    return;
  }
  const { env } = await import("../config/env.js");
  await mongoose.connect(env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
  try {
    console.log(JSON.stringify({ database: mongoose.connection.name, confirm, accountId: id }));
    console.log(JSON.stringify(await eraseMember(id, { confirm })));
  } catch (error) {
    if (error instanceof EraseBlocked) {
      console.error(JSON.stringify({ code: error.code, blockers: error.blockers }));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
// Not on import: the test imports this file.
if (process.argv[1]?.endsWith("erase-member.js")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.name : "UnknownError");
    process.exitCode = 1;
  });
}
