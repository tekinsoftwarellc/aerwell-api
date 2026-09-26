import mongoose from "mongoose";
import { env } from "../config/env.js";
import { syncAllIndexes } from "../config/indexes.js";

// `npm run db:sync-indexes [-- --drop-stale]`: deploy runs it before pm2 start.
// Prints counts and index names only; never documents or connection strings.
async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
  try {
    const result = await syncAllIndexes({ dropStale: process.argv.includes("--drop-stale") });
    console.log(`Indexes in sync for ${result.models} models.`);
    for (const { collection, index } of result.stale)
      console.log(`Stale index (not dropped): ${collection}.${index}`);
  } finally {
    await mongoose.disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(`Index sync failed: ${error instanceof Error ? error.name : "UnknownError"}`);
  process.exitCode = 1;
});
