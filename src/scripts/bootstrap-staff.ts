import { ZodError } from "zod";
import { connectDB, disconnectDB } from "../config/database.js";
import {
  BootstrapInputError,
  bootstrapInputFromEnv,
  bootstrapStaff,
} from "./bootstrap-staff.service.js";

// `node dist/scripts/bootstrap-staff.js` (one-off ECS task). Allowed in production.
// Input from env only (AERWELL_ORG_ID, BOOTSTRAP_STAFF_EMAIL/_FIRST_NAME/_LAST_NAME/_PASSWORD,
// optional BOOTSTRAP_LOCATION_*), never argv. Logs the created flags and the location _id
// (the manifest `addresses` key).
async function main(): Promise<void> {
  const input = bootstrapInputFromEnv(process.env);
  await connectDB();
  try {
    console.log(JSON.stringify(await bootstrapStaff(input)));
  } finally {
    await disconnectDB();
  }
}
main().catch((error: unknown) => {
  // Only our own validation messages are known to hold no values; anything else (a driver
  // error can echo the URI or a document) logs its name only.
  const safe = error instanceof ZodError || error instanceof BootstrapInputError;
  const name = error instanceof Error ? error.name : "UnknownError";
  console.error(`Bootstrap failed: ${safe ? `${name}: ${(error as Error).message}` : name}`);
  process.exitCode = 1;
});
