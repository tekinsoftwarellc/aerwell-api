import mongoose from "mongoose";
import { env } from "../config/env.js";
import { cleanupEverhaus } from "./cleanup-everhaus.service.js";

// Operator-run once: `npm run cleanup:everhaus -- --dry-run` prints what would
// change; without the flag it applies. Prints counts only, never documents or
// connection strings. Never wired into deploy hooks.
async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  await mongoose.connect(env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
  try {
    const report = await cleanupEverhaus({ dryRun });
    for (const [key, value] of Object.entries(report)) console.log(`${key}: ${value}`);
  } finally {
    await mongoose.disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(`Everhaus cleanup failed: ${error instanceof Error ? error.name : "UnknownError"}`);
  process.exitCode = 1;
});
