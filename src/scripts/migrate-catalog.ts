import mongoose from "mongoose";
import { migrateLegacyCatalog } from "../api/catalog/catalog.migration.js";
import { env } from "../config/env.js";

// Operator-run only; never wired into deploy hooks. Run BEFORE seeding the client
// catalog on a database that has the original W4 tier plans.
async function main(): Promise<void> {
  if (!process.argv.includes("--confirm-catalog-migration"))
    throw new Error("Explicit --confirm-catalog-migration is required");
  await mongoose.connect(env.MONGODB_URI);
  try {
    console.log(JSON.stringify(await migrateLegacyCatalog()));
  } finally {
    await mongoose.disconnect();
  }
}
main().catch(() => {
  console.error("Catalog migration failed. Check the confirmation flag and database connectivity.");
  process.exitCode = 1;
});
