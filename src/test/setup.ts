import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll } from "vitest";

// Explicit test values: never load a developer or deployment .env.
process.env["NODE_ENV"] = "test";
process.env["MONGODB_URI"] = "mongodb://127.0.0.1:27017/aerwell-test-placeholder";
process.env["STAFF_JWT_SECRET"] = "test-only-signing-key-not-for-deployment-12345";
process.env["AERWELL_ORG_ID"] = "org-test";
process.env["ADMIN_BASE_URL"] = "http://localhost:3200";
// Alfred partner contract: the org Alfred holds for Aerwell (tokens are minted in test/partnerFixture.ts).
process.env["ALFRED_PARTNER_ORG_ID"] = "alfred-org-aerwell";
// The global per-IP limiter would count every request a whole test file makes.
process.env["RATE_LIMIT_MAX"] = "1000000";
let mongoServer: MongoMemoryReplSet;
beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  // Index builds are async; idempotency and uniqueness tests race them unless awaited.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
});
afterEach(async () => {
  for (const collection of (await mongoose.connection.db?.collections()) ?? []) {
    await collection.deleteMany({});
  }
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
