import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../server.js";
import { client, idOf, memberRow } from "../../test/memberFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AuditEvent } from "../audit/audit.js";
import type { MemberDocument } from "../member/member.model.js";
import { InjectionLog, ProtocolRevision } from "./protocol.model.js";
import { progress } from "./protocols.service.js";

let app: ReturnType<typeof createServer>;
let admin: ReturnType<typeof client>;
let providerId: string;
let member: MemberDocument;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-09T18:00:00Z"));
  app = createServer();
  const fixture = await staffFixture(true);
  admin = client(app, fixture.accessToken);
  providerId = idOf(fixture.staff);
  member = await memberRow();
});
afterEach(() => vi.useRealTimers());
const path = (suffix: string, id = idOf(member)) => `/members/${id}${suffix}`;
const recovery = () => ({
  type: "Peptide Protocol",
  name: "Recovery Protocol: BPC-157 / TB-500",
  prescribingProviderId: providerId,
  startDate: "2026-09-08",
  estEndDate: "2026-11-17",
  supplyRemainingDays: 18,
  items: [
    {
      compound: "BPC-157",
      doseAmount: 250,
      doseUnit: "mcg",
      frequencyCount: 2,
      frequencyPeriod: "weekly",
      route: "subcutaneous",
    },
    {
      compound: "TB-500",
      doseAmount: 2,
      doseUnit: "mg",
      frequencyCount: 1,
      frequencyPeriod: "weekly",
      route: "subcutaneous",
    },
  ],
});
const create = async (body: object = recovery()) =>
  (await admin.send("post", path("/protocols"), body)).body.data;

describe("protocol progress", () => {
  it("is calendar arithmetic over the entered dates", () => {
    expect(progress("2026-09-08", "2026-11-17", "2026-09-09")).toEqual({
      durationWeeks: 10,
      currentWeek: 1,
      percentComplete: 1,
    });
    expect(progress("2026-09-08", "2026-11-17", "2026-12-01")).toMatchObject({
      currentWeek: 10,
      percentComplete: 100,
    });
    expect(progress("2026-09-08", "2026-11-17", "2026-09-01")).toMatchObject({
      currentWeek: 0,
      percentComplete: 0,
    });
  });
});

describe("protocols", () => {
  it("creates with provider name and progress, and filters history by status on both sides", async () => {
    // The older protocol is created first so insertion order cannot produce the sort.
    const old = await create({
      ...recovery(),
      name: "Joint Support Protocol: Glutathione",
      startDate: "2026-06-01",
      estEndDate: "2026-07-15",
    });
    const active = await create();
    expect(active).toMatchObject({
      status: "active",
      durationWeeks: 10,
      currentWeek: 1,
      prescribingProviderName: "Test Actor",
    });
    await admin.send("post", path(`/protocols/${old._id}/complete`));
    const names = async (status: string) =>
      (await admin.get(path(`/protocols?status=${status}`))).body.data.map(
        (p: { name: string }) => p.name
      );
    expect(await names("active")).toEqual(["Recovery Protocol: BPC-157 / TB-500"]);
    expect(await names("completed")).toEqual(["Joint Support Protocol: Glutathione"]);
    expect(await names("discontinued")).toEqual([]);
    // A later-starting discontinued protocol: status order (the index) must not win over date order.
    const later = await create({
      ...recovery(),
      name: "Later",
      startDate: "2026-09-20",
      estEndDate: "2026-10-20",
    });
    await admin.send("post", path(`/protocols/${later._id}/discontinue`), { reason: "Synthetic" });
    expect(await names("discontinued")).toEqual(["Later"]);
    expect(await names("all")).toEqual([
      "Later",
      "Recovery Protocol: BPC-157 / TB-500",
      "Joint Support Protocol: Glutathione",
    ]);
    const missing = { ...recovery(), prescribingProviderId: "0123456789abcdef01234567" };
    expect((await admin.send("post", path("/protocols"), missing)).status).toBe(404);
    const backwards = { ...recovery(), estEndDate: "2026-09-01" };
    expect((await admin.send("post", path("/protocols"), backwards)).status).toBe(400);
  });
  it("writes a revision on every real adjustment, none on a no-op, and refuses a stale version", async () => {
    const p = await create();
    const items = p.items.map((i: { _id: string }, n: number) => ({
      ...recovery().items[n],
      _id: i._id,
      ...(n === 0 ? { doseAmount: 300 } : {}),
    }));
    const adjusted = await admin.send("patch", path(`/protocols/${p._id}`), {
      expectedVersion: p.version,
      items,
      nextRefillDue: "2026-10-02",
      reason: "Titration",
    });
    expect(adjusted.status).toBe(200);
    expect(adjusted.body.data.items[0]).toMatchObject({ _id: p.items[0]._id, doseAmount: 300 });
    const revisions = (await admin.get(path(`/protocols/${p._id}/revisions`))).body.data;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      action: "adjusted",
      reason: "Titration",
      changedByName: "Test Actor",
    });
    expect(revisions[0].before.items[0].doseAmount).toBe(250);
    expect(revisions[0].after.items[0].doseAmount).toBe(300);
    const noop = await admin.send("patch", path(`/protocols/${p._id}`), {
      expectedVersion: adjusted.body.data.version,
      items,
    });
    expect(noop.status).toBe(200);
    expect(await ProtocolRevision.countDocuments({ protocolId: p._id })).toBe(1);
    const stale = await admin.send("patch", path(`/protocols/${p._id}`), {
      expectedVersion: p.version,
      supplyRemainingDays: 3,
    });
    expect([stale.status, stale.body.code]).toEqual([409, "VERSION_CONFLICT"]);
    const merged = await admin.send("patch", path(`/protocols/${p._id}`), {
      expectedVersion: adjusted.body.data.version,
      estEndDate: "2026-09-01",
    });
    expect([merged.status, merged.body.code]).toEqual([400, "INVALID_DATES"]);
    expect(
      (await admin.send("patch", path(`/protocols/${p._id}`), { expectedVersion: 1 })).status
    ).toBe(400);
  });
  it("discontinues once with a required reason and then refuses changes", async () => {
    const p = await create();
    const route = path(`/protocols/${p._id}/discontinue`);
    expect((await admin.send("post", route, {})).status).toBe(400);
    const done = await admin.send("post", route, { reason: "Adverse reaction" });
    expect(done.body.data).toMatchObject({
      status: "discontinued",
      discontinuedReason: "Adverse reaction",
    });
    expect((await admin.send("post", route, { reason: "Again" })).body.code).toBe(
      "PROTOCOL_NOT_ACTIVE"
    );
    const patch = await admin.send("patch", path(`/protocols/${p._id}`), {
      expectedVersion: done.body.data.version,
      supplyRemainingDays: 1,
    });
    expect(patch.body.code).toBe("PROTOCOL_NOT_ACTIVE");
    const revisions = await ProtocolRevision.find({ protocolId: p._id }).lean();
    expect(revisions.map((r) => [r.action, r.reason])).toEqual([
      ["discontinued", "Adverse reaction"],
    ]);
    expect(
      (
        await admin.send("post", path(`/protocols/${p._id}/discontinue`, idOf(await memberRow())), {
          reason: "x",
        })
      ).status
    ).toBe(404);
  });
  it("logs injections and only a newer one moves the last-injection fields", async () => {
    const p = await create();
    const log = (administeredAt: string, site: string, itemId = p.items[0]._id) =>
      admin.send("post", path(`/protocols/${p._id}/injections`), { itemId, administeredAt, site });
    expect((await log("2026-09-09T15:00:00Z", "Right abdomen")).status).toBe(201);
    expect((await log("2026-09-08T15:00:00Z", "Left abdomen")).status).toBe(201);
    const row = (await admin.get(path(`/protocols/${p._id}`))).body.data;
    expect(row).toMatchObject({
      lastInjectionSite: "Right abdomen",
      lastLoggedInjectionAt: "2026-09-09T15:00:00.000Z",
    });
    expect((await log("2026-09-09T15:00:00Z", "x", "0123456789abcdef01234567")).status).toBe(404);
    expect(await InjectionLog.countDocuments({ protocolId: p._id })).toBe(2);
    expect(
      await AuditEvent.countDocuments({ targetType: "InjectionLog", memberId: idOf(member) })
    ).toBe(2);
  });
});
