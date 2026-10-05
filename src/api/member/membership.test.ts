import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import { ORG, client, idOf, memberRow, staffWith } from "../../test/memberFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AllowanceLedgerEntry } from "../appointment/appointment.model.js";
import { AuditEvent } from "../audit/audit.js";
import { MembershipPlan } from "../catalog/catalog.model.js";
import { Service } from "../service/service.model.js";
import { seedCatalog } from "../service/service.seed.js";
import { type MemberDocument, MemberMembership } from "./member.model.js";

let app: ReturnType<typeof createServer>;
let admin: ReturnType<typeof client>;
let member: MemberDocument;
const plan: Record<string, string> = {};
beforeEach(async () => {
  app = createServer();
  admin = client(app, (await staffFixture(true)).accessToken);
  await seedCatalog(ORG);
  for (const p of await MembershipPlan.find({ organizationId: ORG }))
    plan[String(p.slug)] = String(p._id);
  member = await memberRow();
});
const base = () => `/members/${idOf(member)}/memberships`;
const hold = (slug: string, extra: Record<string, unknown> = {}) =>
  admin.send("post", base(), {
    planId: plan[slug],
    startedAt: "2026-01-15T08:00:00.000Z",
    ...extra,
  });

describe("membership records", () => {
  it("holds overlapping memberships of different plans with a price snapshot", async () => {
    const essential = await hold("aerwell-essential");
    expect(essential.status).toBe(201);
    expect(essential.body.data).toMatchObject({
      status: "active",
      priceCents: 19900,
      periodAnchor: "anniversary",
    });
    expect((await hold("aerwell-continuum")).status).toBe(201);
    const list = await admin.get(base());
    expect(list.body.data.items.map((m: { planName: string }) => m.planName).sort()).toEqual([
      "Aerwell Continuum",
      "Aerwell Essential",
    ]);
    expect(list.body.data.clinicianChatAllowed).toBe(true);
    expect(
      await AuditEvent.countDocuments({ targetType: "MemberMembership", action: "created" })
    ).toBe(2);
  });
  it("refuses an overlapping second record of the same plan, allows a later one", async () => {
    await hold("aerwell-essential", { endsAt: "2026-06-01T00:00:00.000Z" });
    const overlap = await hold("aerwell-essential", { startedAt: "2026-05-01T00:00:00.000Z" });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe("MEMBERSHIP_OVERLAP");
    expect(
      (await hold("aerwell-essential", { startedAt: "2026-06-01T00:00:00.000Z" })).status
    ).toBe(201);
    const open = await hold("aerwell-essential", { startedAt: "2027-01-01T00:00:00.000Z" });
    expect(open.status).toBe(409);
    const [first] = (await admin.get(base())).body.data.items.filter(
      (m: { endsAt: string | null }) => m.endsAt === "2026-06-01T00:00:00.000Z"
    );
    const extend = await admin.send("patch", `${base()}/${first._id}`, { endsAt: null });
    expect(extend.status).toBe(409);
    expect(extend.body.code).toBe("MEMBERSHIP_OVERLAP");
  });
  it("lets only one of two concurrent same-plan requests through", async () => {
    const results = await Promise.all([hold("aerwell-continuum"), hold("aerwell-continuum")]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await MemberMembership.countDocuments({ memberId: member._id })).toBe(1);
  });
  it("refuses legacy, archived or unknown plans", async () => {
    const legacy = await MembershipPlan.create({ organizationId: ORG, name: "Legacy tier" });
    plan["legacy"] = String(legacy._id);
    const refused = await hold("legacy");
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("PLAN_NOT_ASSIGNABLE");
    await MembershipPlan.updateOne(
      { _id: plan["aerwell-continuum"] },
      { $set: { status: "archived" } }
    );
    expect((await hold("aerwell-continuum")).status).toBe(422);
    expect((await admin.send("post", base(), { planId: idOf(member) })).status).toBe(404);
    expect(await MemberMembership.countDocuments()).toBe(0);
  });
  it("cancels, refuses reactivation and stale versions", async () => {
    const created = await hold("aerwell-essential");
    const url = `${base()}/${created.body.data._id}`;
    const stale = await admin.send("patch", url, { autoRenew: false, expectedVersion: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    const cancelled = await admin.send("patch", url, { status: "cancelled", expectedVersion: 0 });
    expect(cancelled.body.data).toMatchObject({ status: "cancelled" });
    expect(cancelled.body.data.cancelledAt).toBeTruthy();
    const again = await admin.send("patch", url, { status: "active" });
    expect(again.status).toBe(422);
    expect(again.body.code).toBe("INVALID_MEMBERSHIP_TRANSITION");
    expect((await admin.get(base())).body.data.clinicianChatAllowed).toBe(false);
    expect((await admin.send("patch", url, { expectedVersion: 1 })).status).toBe(400);
  });
  it("needs MEMBER_RECORDS edit to change memberships; view can read them", async () => {
    const viewer = client(app, (await staffWith({ MEMBER_RECORDS: "view" })).accessToken);
    expect((await viewer.get(base())).status).toBe(200);
    expect((await viewer.send("post", base(), { planId: plan["aerwell-essential"] })).status).toBe(
      403
    );
  });
  it("creates memberships together with the member", async () => {
    const res = await admin.send("post", "/members", {
      firstName: "With",
      lastName: "Plan",
      email: "with-plan@example.invalid",
      memberships: [{ planId: plan["aerwell-continuum"], startedAt: "2026-02-01T00:00:00.000Z" }],
    });
    expect(res.status).toBe(201);
    expect(await MemberMembership.countDocuments({ memberId: res.body.data._id })).toBe(1);
    expect(res.body.data.brandLabel).toBe("Aerwell Member");
    const legacy = await MembershipPlan.create({ organizationId: ORG, name: "Legacy tier" });
    const bad = await admin.send("post", "/members", {
      firstName: "Bad",
      lastName: "Plan",
      email: "bad-plan@example.invalid",
      memberships: [{ planId: String(legacy._id) }],
    });
    expect(bad.status).toBe(422);
    expect((await admin.get("/members?q=bad-plan")).body.data.items).toEqual([]);
  });
});

describe("benefits view", () => {
  it("reports used/remaining from the allowance ledger and anniversary renewal", async () => {
    const holding = await hold("aerwell-continuum");
    const assessmentId = (await Service.findOne({ slug: "advanced-assessment" }).lean())?._id;
    const dexaId = (await Service.findOne({ slug: "dexa-scan" }).lean())?._id;
    await MembershipPlan.updateOne(
      { _id: plan["aerwell-continuum"] },
      {
        $push: {
          benefits: {
            id: String(dexaId),
            serviceId: dexaId,
            access: "eligible",
            includedQuantity: 0,
            period: null,
            exhaustion: "paid",
            pricing: { mode: "discount", discountBps: 2000 },
          },
        },
      }
    );
    const entry = (
      periodStart: string,
      status: string,
      periodEnd = "2027-01-15T08:00:00.000Z"
    ) => ({
      organizationId: ORG,
      memberId: member._id,
      membershipId: holding.body.data._id,
      planId: holding.body.data.planId,
      benefitId: String(assessmentId),
      serviceId: assessmentId,
      periodStart: new Date(periodStart),
      periodEnd: new Date(periodEnd),
      status,
      holding: status !== "released",
    });
    // Counted: reserved + consumed in the current period. Not counted: released, previous period.
    await AllowanceLedgerEntry.create([
      entry("2026-01-15T08:00:00.000Z", "reserved"),
      entry("2026-01-15T08:00:00.000Z", "consumed"),
      entry("2026-01-15T08:00:00.000Z", "released"),
      entry("2025-01-15T08:00:00.000Z", "consumed", "2026-01-15T08:00:00.000Z"),
    ]);
    const res = await admin.get(`/members/${idOf(member)}/benefits?at=2026-09-26T00:00:00.000Z`);
    expect(res.status).toBe(200);
    expect(res.body.data.usage.tracked).toBe(true);
    expect(res.body.data.clinicianChatAllowed).toBe(true);
    const [held] = res.body.data.memberships;
    const assessment = held.benefits.find(
      (b: { serviceSlug: string }) => b.serviceSlug === "advanced-assessment"
    );
    expect(assessment).toMatchObject({
      includedQuantity: 4,
      used: 2,
      remaining: 2,
      periodStart: "2026-01-15T08:00:00.000Z",
      renewsAt: "2027-01-15T08:00:00.000Z",
    });
    const dexa = held.benefits.find((b: { serviceSlug: string }) => b.serviceSlug === "dexa-scan");
    expect(held.brand).toBeUndefined();
    expect(dexa).toMatchObject({
      includedQuantity: 0,
      used: null,
      remaining: null,
      renewsAt: null,
    });
    expect(dexa.pricing).toEqual({ mode: "discount", discountBps: 2000 });
    expect(
      await AuditEvent.countDocuments({ targetType: "MemberBenefits", action: "viewed" })
    ).toBe(1);
  });
  it("lists nothing for a member with no current membership and denies clinician chat", async () => {
    await hold("aerwell-essential", { startedAt: "2027-01-01T00:00:00.000Z" });
    const res = await admin.get(`/members/${idOf(member)}/benefits?at=2026-09-26T00:00:00.000Z`);
    expect(res.body.data.memberships).toEqual([]);
    expect(res.body.data.clinicianChatAllowed).toBe(false);
    expect(await Service.countDocuments({ organizationId: ORG })).toBeGreaterThan(0);
  });
});
