import mongoose from "mongoose";
import { expect, it } from "vitest";
import { ProcessorEvent } from "../api/billing/billing.model.js";
import { syncAllIndexes } from "./indexes.js";

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
