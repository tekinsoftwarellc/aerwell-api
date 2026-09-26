import mongoose from "mongoose";

export interface IndexSyncResult {
  models: number;
  /** Indexes in the database that no schema declares (names only). */
  stale: { collection: string; index: string }[];
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
