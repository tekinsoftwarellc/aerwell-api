import mongoose from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditEvent, CLINICAL_AUDIT_TTL_SECONDS } from "../api/audit/audit.js";
import { CONNECT_OPTIONS, runAuditTtlMigration } from "./migrate-audit-ttl.js";

function db() {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error("not connected");
  return handle;
}
const index = async (name: string) =>
  (await db().collection("auditevents").indexes()).find((i) => i.name === name);

describe("migrate:audit-ttl", () => {
  beforeEach(async () => {
    await AuditEvent.createCollection().catch(() => undefined);
    await AuditEvent.init();
    // The deployed state: schema indexes only. Earlier tests in this file add occurredAt_1.
    await db()
      .collection("auditevents")
      .dropIndex("occurredAt_1")
      .catch(() => undefined);
  });

  it("connects without autoIndex/autoCreate so dry run cannot write", () => {
    expect(CONNECT_OPTIONS).toMatchObject({ autoIndex: false, autoCreate: false });
  });

  it("is six years incl. leap days", () => {
    expect(CLINICAL_AUDIT_TTL_SECONDS).toBe(189_388_800);
  });

  it("dry run creates nothing", async () => {
    const r = await runAuditTtlMigration(db(), { confirm: false });
    expect(r.action).toBe("created");
    expect(await index("occurredAt_1")).toBeUndefined();
    expect(r.before).toEqual(r.after);
  });

  it("confirm creates occurredAt_1 with 189388800", async () => {
    const r = await runAuditTtlMigration(db(), { confirm: true });
    expect(r.action).toBe("created");
    expect((await index("occurredAt_1"))?.expireAfterSeconds).toBe(189_388_800);
    expect(r.after.map((i) => i.name)).toContain("occurredAt_1");
  });

  it("second confirm noop", async () => {
    await runAuditTtlMigration(db(), { confirm: true });
    expect((await runAuditTtlMigration(db(), { confirm: true })).action).toBe("noop");
  });

  it("a different TTL value is collMod'd, not duplicated", async () => {
    await db()
      .collection("auditevents")
      .createIndex({ occurredAt: 1 }, { expireAfterSeconds: 100 });
    const r = await runAuditTtlMigration(db(), { confirm: true });
    expect(["collMod", "recreated"]).toContain(r.action);
    expect((await index("occurredAt_1"))?.expireAfterSeconds).toBe(189_388_800);
  });

  it("refuses when auditevents is absent", async () => {
    await db().collection("auditevents").drop();
    await expect(runAuditTtlMigration(db(), { confirm: true })).rejects.toThrow(
      /auditevents missing/
    );
  });

  it("existing compound occurredAt indexes are untouched", async () => {
    const before = (await db().collection("auditevents").indexes()).map((i) => i.name);
    await runAuditTtlMigration(db(), { confirm: true });
    const after = (await db().collection("auditevents").indexes()).map((i) => i.name);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after.filter((n) => !before.includes(n))).toEqual(["occurredAt_1"]);
  });
});
