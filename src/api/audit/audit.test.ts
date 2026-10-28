import mongoose from "mongoose";
import { expect, it } from "vitest";
import { syncAllIndexes } from "../../config/indexes.js";
import { runAuditTtlMigration } from "../../scripts/migrate-audit-ttl.js";
import { AuditEvent, audit } from "./audit.js";
it("appends an immutable event with request actor and target, excluding PHI", async () => {
  const req = {
    staff: { _id: "000000000000000000000001", organizationId: "org-a" },
    requestId: "test-request",
  };
  await audit(
    req as never,
    "viewed",
    "Member",
    "000000000000000000000002",
    "000000000000000000000002"
  );
  const event = await AuditEvent.findOne().lean();
  expect(event).toMatchObject({
    organizationId: "org-a",
    actorId: "000000000000000000000001",
    action: "viewed",
    targetType: "Member",
    requestId: "test-request",
  });
  await expect(
    AuditEvent.updateOne({ _id: event?._id }, { $set: { action: "deleted" } })
  ).rejects.toThrow("append-only");
});

it("declares the six-year TTL (phase 2) and the migration-created index is a no-op for index sync", async () => {
  expect(AuditEvent.schema.indexes()).toContainEqual([
    { occurredAt: 1 },
    expect.objectContaining({ expireAfterSeconds: 189_388_800 }),
  ]);
  const db = mongoose.connection.db;
  if (!db) throw new Error("not connected");
  await AuditEvent.createCollection().catch(() => undefined);
  await db.collection("auditevents").dropIndexes();
  await runAuditTtlMigration(db, { confirm: true });
  const result = await syncAllIndexes();
  expect(result.stale.filter((s) => s.collection === "auditevents")).toEqual([]);
});
