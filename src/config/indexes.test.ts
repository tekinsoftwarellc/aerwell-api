import mongoose from "mongoose";
import { expect, it } from "vitest";
import { ProcessorEvent } from "../api/billing/billing.model.js";
import { describeIndexSyncFailure, syncAllIndexes } from "./indexes.js";

it("creates every declared index on a fresh database, idempotently, and only reports stale ones", async () => {
  // A fresh deploy: the collection exists but autoIndex has not built anything yet.
  await ProcessorEvent.collection.dropIndexes();
  await ProcessorEvent.collection.createIndex({ legacy: 1 }, { name: "legacy_1" });
  const first = await syncAllIndexes();
  const names = (await ProcessorEvent.collection.indexes()).map((i) => i.name);
  expect(names).toContain("eventId_1");
  const unique = (await ProcessorEvent.collection.indexes()).find((i) => i.name === "eventId_1");
  expect(unique?.unique).toBe(true);
  expect(first.models).toBeGreaterThan(40);
  expect(first.stale).toContainEqual({ collection: "processorevents", index: "legacy_1" });
  expect(names).toContain("legacy_1"); // reported, never dropped by default
  // Webhook dedupe now holds.
  await ProcessorEvent.create({ eventId: "evt_1", type: "x", outcome: "applied" });
  await expect(
    ProcessorEvent.create({ eventId: "evt_1", type: "x", outcome: "applied" })
  ).rejects.toMatchObject({ code: 11000 });
  const again = await syncAllIndexes();
  expect(again.models).toBe(first.models);
  await syncAllIndexes({ dropStale: true });
  expect((await ProcessorEvent.collection.indexes()).map((i) => i.name)).not.toContain("legacy_1");
  expect(mongoose.connection.readyState).toBe(1);
});

it("describes a failure with collection, index, code, codeName only", () => {
  const err = Object.assign(new Error('E11000 dup key: { email: "a@b.c" } mongodb://u:p@h'), {
    collection: "members",
    index: "email_1",
    code: 11000,
    codeName: "DuplicateKey",
  });
  expect(describeIndexSyncFailure(err)).toBe(
    "Index sync failed: collection=members index=email_1 code=11000 codeName=DuplicateKey name=Error"
  );
  expect(describeIndexSyncFailure("boom")).toBe(
    "Index sync failed: collection=unknown index=unknown code=unknown codeName=unknown name=unknown"
  );
  const connect = Object.assign(new Error("secret mongodb://u:p@h"), {
    name: "MongooseServerSelectionError",
  });
  expect(describeIndexSyncFailure(connect)).toBe(
    "Index sync failed: collection=unknown index=unknown code=unknown codeName=unknown name=MongooseServerSelectionError"
  );
});

it("rejects with the collection and index that conflicted", async () => {
  await ProcessorEvent.collection.dropIndexes();
  await ProcessorEvent.collection.createIndex({ eventId: 1 }, { name: "eventId_1" }); // not unique: conflicts with schema
  try {
    await expect(syncAllIndexes()).rejects.toMatchObject({
      collection: "processorevents",
      index: "eventId_1",
      code: expect.any(Number),
      codeName: expect.any(String),
    });
  } finally {
    await ProcessorEvent.collection.dropIndexes();
    await syncAllIndexes();
  }
});
