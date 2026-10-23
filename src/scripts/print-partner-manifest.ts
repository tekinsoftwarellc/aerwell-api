import { readFileSync } from "node:fs";
import mongoose from "mongoose";
import { type ClientManifestValues, manifestFor } from "../api/alfred-partner/partner.manifest.js";
import { env } from "../config/env.js";

// `npm run partner:manifest -- client-values.json`: prints the manifest to register with Alfred.
// The client values file holds terms, support and street addresses (no secrets, no member data).
// Container one-off tasks have no file to mount: with no path, PARTNER_MANIFEST_VALUES_JSON holds the JSON.
/** Parses and shape-checks the client values before any database connection. */
function readClientValues(path: string | undefined, inline: string | undefined) {
  let client: unknown;
  try {
    client = JSON.parse(path ? readFileSync(path, "utf8") : (inline as string));
  } catch (error) {
    throw new Error(`client values are not readable JSON (${(error as Error).name})`);
  }
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(client)) throw new Error("client values must be a JSON object");
  for (const field of ["terms", "support", "addresses"])
    if (!isObject(client[field])) throw new Error(`client values: ${field} must be an object`);
  return client as unknown as ClientManifestValues;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  const inline = process.env["PARTNER_MANIFEST_VALUES_JSON"];
  if (!((path || inline) && env.AERWELL_ORG_ID))
    throw new Error(
      "Usage: partner:manifest <client-values.json> or PARTNER_MANIFEST_VALUES_JSON (AERWELL_ORG_ID set)"
    );
  const client = readClientValues(path, inline);
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  try {
    console.log(JSON.stringify(await manifestFor(env.AERWELL_ORG_ID, client), null, 2));
  } finally {
    await mongoose.disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(`Manifest failed: ${error instanceof Error ? error.message : "UnknownError"}`);
  process.exitCode = 1;
});
