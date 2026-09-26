import mongoose from "mongoose";
import { env } from "../config/env.js";
import { seedDevelopmentData } from "./seed.service.js";

// Explicit local operator invocation only. Never automatically run by deploy hooks.
async function main(): Promise<void> {
  if (env.NODE_ENV === "production") throw new Error("Development seed cannot run in production");
  if (!process.argv.includes("--confirm-local-seed"))
    throw new Error("Explicit --confirm-local-seed is required");
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(env.MONGODB_URI))
    throw new Error("Development seed accepts localhost MongoDB only");
  const input = {
    organizationId: env.AERWELL_ORG_ID ?? "",
    email: process.env["SEED_SUPER_ADMIN_EMAIL"] ?? "",
    password: process.env["SEED_SUPER_ADMIN_PASSWORD"] ?? "",
    firstName: process.env["SEED_SUPER_ADMIN_FIRST_NAME"] ?? "",
    lastName: process.env["SEED_SUPER_ADMIN_LAST_NAME"] ?? "",
  };
  await mongoose.connect(env.MONGODB_URI);
  try {
    await seedDevelopmentData(input);
    console.log("Local Aerwell seed completed.");
  } finally {
    await mongoose.disconnect();
  }
}
main().catch(() => {
  console.error("Seed failed. Check required seed configuration and local-only confirmation.");
  process.exitCode = 1;
});
