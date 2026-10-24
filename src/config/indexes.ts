import mongoose from "mongoose";

export interface IndexSyncResult {
  models: number;
  /** Indexes in the database that no schema declares (names only). */
  stale: { collection: string; index: string }[];
}

/** Safe to log: never the error message (can echo key values) or the URI. */
export function describeIndexSyncFailure(error: unknown): string {
  const e = (error ?? {}) as Record<string, unknown>;
  const pick = (k: string) =>
    typeof e[k] === "string" || typeof e[k] === "number" ? String(e[k]) : "unknown";
  return `Index sync failed: collection=${pick("collection")} index=${pick("index")} code=${pick("code")} codeName=${pick("codeName")}`;
}

function withContext(error: unknown, collection: string, index: string): Error {
  const { code, codeName } = (error ?? {}) as { code?: unknown; codeName?: unknown };
  return Object.assign(new Error("Index sync failed"), { collection, index, code, codeName });
}

/**
 * Indexes replaced by a differently-named one. Mongo refuses to create an index whose name exists
 * with other options, and a stale full unique index would keep rejecting members that have no email.
 */
const RETIRED_INDEXES = [{ model: "Member", index: "organizationId_1_email_1" }];

export async function dropRetiredIndexes(): Promise<void> {
  for (const { model, index } of RETIRED_INDEXES) {
    const target = mongoose.models[model];
    if (!target) continue;
    await target.collection.dropIndex(index).catch((error: { codeName?: string }) => {
      // Not there (fresh database, or already dropped): nothing to do.
      if (error.codeName !== "IndexNotFound" && error.codeName !== "NamespaceNotFound")
        throw withContext(error, target.collection.collectionName, index);
    });
  }
}

/**
 * Builds every index the schemas declare (createIndexes: idempotent, never
 * drops). Run BEFORE traffic: webhook dedupe and booking idempotency depend on
 * unique indexes that autoIndex would otherwise build in the background.
 * Stale indexes are only reported unless `dropStale` (syncIndexes) is passed.
 */
export async function syncAllIndexes(options: { dropStale?: boolean } = {}) {
  // Importing the app registers every model with mongoose.
  await import("../server.js");
  const result: IndexSyncResult = { models: 0, stale: [] };
  await dropRetiredIndexes();
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection().catch(() => undefined); // already exists
    const collection = model.collection.collectionName;
    let failed = "unknown";
    const onIndex = (err: unknown, fields: Record<string, unknown>, opts?: { name?: string }) => {
      if (err && failed === "unknown")
        failed =
          opts?.name ??
          Object.entries(fields)
            .map(([k, v]) => `${k}_${v}`)
            .join("_");
    };
    model.on("index-single-done", onIndex);
    try {
      if (options.dropStale) await model.syncIndexes();
      else await model.createIndexes();
      const { toDrop } = await model.diffIndexes();
      for (const index of toDrop) result.stale.push({ collection, index: String(index) });
      result.models += 1;
    } catch (error) {
      throw withContext(error, collection, failed);
    } finally {
      model.off("index-single-done", onIndex);
    }
  }
  return result;
}
