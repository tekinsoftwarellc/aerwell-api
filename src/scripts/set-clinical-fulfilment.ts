import mongoose from "mongoose";
import { env } from "../config/env.js";
import { setClinicalFulfilment } from "./clinical-fulfilment.service.js";

// Operator-run once, AFTER the clinical routes are deployed and `clinical` is declared in the manifest:
//   npm run clinical:fulfilment            dry run (default): prints what would change
//   npm run clinical:fulfilment -- --apply writes it
// Prints slugs and counts only. Never wired into deploy hooks.
async function main(): Promise<void> {
  if (!env.AERWELL_ORG_ID) throw new Error("AERWELL_ORG_ID is not set");
  await mongoose.connect(env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
  try {
    const report = await setClinicalFulfilment(env.AERWELL_ORG_ID, {
      dryRun: !process.argv.includes("--apply"),
    });
    console.log(JSON.stringify(report));
  } finally {
    await mongoose.disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(
    `Clinical fulfilment failed: ${error instanceof Error ? error.name : "UnknownError"}`
  );
  process.exitCode = 1;
});
