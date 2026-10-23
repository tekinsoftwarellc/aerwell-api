import { connectDB, disconnectDB } from "../config/database.js";
import { bootstrapInputFromEnv, bootstrapStaff } from "./bootstrap-staff.service.js";

// `node dist/scripts/bootstrap-staff.js` (one-off ECS task). Allowed in production.
// Input from env only (AERWELL_ORG_ID, BOOTSTRAP_STAFF_EMAIL/_FIRST_NAME/_LAST_NAME/_PASSWORD),
// never argv. Logs the three booleans only.
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
  console.error(`Bootstrap failed: ${error instanceof Error ? error.message : "UnknownError"}`);
  process.exitCode = 1;
});
