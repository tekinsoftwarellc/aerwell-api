import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll } from "vitest";

// Explicit test values: never load a developer or deployment .env.
process.env["NODE_ENV"] = "test";
process.env["MONGODB_URI"] = "mongodb://127.0.0.1:27017/aerwell-test-placeholder";
process.env["STAFF_JWT_SECRET"] = "test-only-signing-key-not-for-deployment-12345";
process.env["AERWELL_ORG_ID"] = "org-test";
process.env["ADMIN_BASE_URL"] = "http://localhost:3200";
let mongoServer: MongoMemoryServer;
beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
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
