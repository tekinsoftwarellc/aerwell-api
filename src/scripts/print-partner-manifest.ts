import { readFileSync } from "node:fs";
import mongoose from "mongoose";
import { manifestFor } from "../api/alfred-partner/partner.manifest.js";
import { env } from "../config/env.js";

// `npm run partner:manifest -- client-values.json`: prints the manifest to register with Alfred.
// The client values file holds terms, support and street addresses (no secrets, no member data).
async function main(): Promise<void> {
  const path = process.argv[2];
  if (!(path && env.AERWELL_ORG_ID))
    throw new Error("Usage: partner:manifest <client-values.json> (AERWELL_ORG_ID set)");
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  try {
    const client = JSON.parse(readFileSync(path, "utf8"));
    console.log(JSON.stringify(await manifestFor(env.AERWELL_ORG_ID, client), null, 2));
  } finally {
    await mongoose.disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(`Manifest failed: ${error instanceof Error ? error.message : "UnknownError"}`);
  process.exitCode = 1;
});
