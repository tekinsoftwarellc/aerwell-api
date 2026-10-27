import mongoose from "mongoose";
import { CLINICAL_AUDIT_TTL_SECONDS } from "../api/audit/audit.js";
import { env } from "../config/env.js";

// `node dist/scripts/migrate-audit-ttl.js [--dry-run]` reports only (default);
// `--confirm` writes. Phase 1 of decision 2B: adds `auditevents { occurredAt: 1 }` with a
// six-year TTL. The schema does not declare it until phase 2, so this creates it. Do NOT run
// `db:sync-indexes -- --drop-stale` between the two phases: it would drop the new index.
// Prints the database NAME (never the URI), the index list before and after, and the action.
// Refuses when `auditevents` does not exist (wrong-database guard).
const COLLECTION = "auditevents";
const KEY = { occurredAt: 1 } as const;

export interface IndexInfo {
  name: string;
  key: Record<string, unknown>;
  expireAfterSeconds?: number;
}
export type TtlAction = "created" | "collMod" | "recreated" | "noop";

const listIndexes = async (db: mongoose.mongo.Db): Promise<IndexInfo[]> =>
  (await db.collection(COLLECTION).indexes()).map((i) => ({
    name: String(i["name"]),
    key: i["key"] as Record<string, unknown>,
    ...(typeof i["expireAfterSeconds"] === "number"
      ? { expireAfterSeconds: i["expireAfterSeconds"] }
      : {}),
  }));

const onKey = (i: IndexInfo): boolean =>
  Object.keys(i.key).length === 1 && i.key["occurredAt"] === 1;

function plan(found: IndexInfo | undefined): TtlAction {
  if (!found) return "created";
  return found.expireAfterSeconds === CLINICAL_AUDIT_TTL_SECONDS ? "noop" : "collMod";
}

async function apply(db: mongoose.mongo.Db, found: IndexInfo | undefined): Promise<TtlAction> {
  const coll = db.collection(COLLECTION);
  const options = { expireAfterSeconds: CLINICAL_AUDIT_TTL_SECONDS };
  if (!found) {
    await coll.createIndex(KEY, options);
    return "created";
  }
  try {
    await db.command({ collMod: COLLECTION, index: { keyPattern: KEY, ...options } });
    return "collMod";
  } catch {
    // One index per key pattern, so drop first. A window with no TTL only delays deletion.
    await coll.dropIndex(found.name);
    await coll.createIndex(KEY, options);
    return "recreated";
  }
}

export async function runAuditTtlMigration(
  db: mongoose.mongo.Db,
  opts: { confirm: boolean }
): Promise<{ action: TtlAction; before: IndexInfo[]; after: IndexInfo[] }> {
  if ((await db.listCollections({ name: COLLECTION }).toArray()).length === 0) {
    throw new Error(`${COLLECTION} missing in database "${db.databaseName}"`);
  }
  const before = await listIndexes(db);
  const found = before.find(onKey);
  const planned = plan(found);
  if (!opts.confirm || planned === "noop") return { action: planned, before, after: before };

  const action = await apply(db, found);
  const after = await listIndexes(db);
  if (after.find(onKey)?.expireAfterSeconds !== CLINICAL_AUDIT_TTL_SECONDS) {
    throw new Error(
      `${COLLECTION} occurredAt TTL is not ${CLINICAL_AUDIT_TTL_SECONDS} after ${action}`
    );
  }
  return { action, before, after };
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const out = (o: unknown): void => console.log(JSON.stringify(o));
  await mongoose.connect(env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error("database not connected");
    out({ database: mongoose.connection.name, confirm });
    const r = await runAuditTtlMigration(db, { confirm });
    out({ before: r.before });
    out({ after: r.after });
    out({ action: r.action, wrote: confirm && r.action !== "noop" });
  } finally {
    await mongoose.disconnect();
  }
}
// Not on import: the test imports this file.
if (process.argv[1]?.endsWith("migrate-audit-ttl.js")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
