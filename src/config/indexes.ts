import mongoose from "mongoose";

export interface IndexSyncResult {
  models: number;
  /** Indexes in the database that no schema declares (names only). */
  stale: { collection: string; index: string }[];
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
      if (error.codeName !== "IndexNotFound" && error.codeName !== "NamespaceNotFound") throw error;
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
    if (options.dropStale) await model.syncIndexes();
    else await model.createIndexes();
    const { toDrop } = await model.diffIndexes();
    for (const index of toDrop)
      result.stale.push({ collection: model.collection.collectionName, index: String(index) });
    result.models += 1;
  }
  return result;
}
