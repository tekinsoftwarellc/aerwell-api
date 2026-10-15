import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearServiceTokenCache } from "../../../common/services/serviceTokenClient.js";
import { env } from "../../../config/env.js";
import { createServer } from "../../../server.js";
import { ORG, client, idOf, memberRow } from "../../../test/memberFixture.js";
import {
  ACCOUNT,
  alfredClient,
  installAlfredKeys,
  removeAlfredKeys,
} from "../../../test/partnerFixture.js";
import { staffFixture } from "../../../test/staffFixture.js";
import { MembershipPlan } from "../../catalog/catalog.model.js";
import { Member, type MemberDocument, MemberMembership } from "../../member/member.model.js";
import { seedCatalog } from "../../service/service.seed.js";
import { PlanGrantOutbox } from "./planGrant.model.js";
import { drainPlanGrants } from "./planGrant.publisher.js";

const app = createServer();
let admin: ReturnType<typeof client>;
let member: MemberDocument;
const plan: Record<string, string> = {};
const ACC = "6710bb4e2f9c1a0031d5e7d1";
beforeEach(async () => {
  clearServiceTokenCache();
  (env as { ALFRED_PLAN_GRANTS_ENABLED: string }).ALFRED_PLAN_GRANTS_ENABLED = "true";
  admin = client(app, (await staffFixture(true)).accessToken);
  await seedCatalog(ORG);
  for (const p of await MembershipPlan.find({ organizationId: ORG }))
    plan[String(p.slug)] = String(p._id);
  member = await memberRow({ alfredAccountId: ACC });
});
afterEach(() => {
  (env as { ALFRED_PLAN_GRANTS_ENABLED: string }).ALFRED_PLAN_GRANTS_ENABLED = "false";
  vi.unstubAllGlobals();
});
const base = () => `/members/${idOf(member)}/memberships`;
const hold = (slug: string, extra: Record<string, unknown> = {}) =>
  admin.send("post", base(), { planId: plan[slug], ...extra });
const queued = () => PlanGrantOutbox.find().sort({ createdAt: 1 }).lean();

describe("outbound enqueue", () => {
  it("queues create (open-ended), update and cancel with the plan slug", async () => {
    const created = await hold("aerwell-continuum", { endsAt: "2030-01-01T00:00:00.000Z" });
    const url = `${base()}/${created.body.data._id}`;
    await admin.send("patch", url, { status: "paused" });
    await admin.send("patch", url, { status: "cancelled" });
    const rows = await queued();
    expect(rows.map((r) => (r.body as { status: string }).status)).toEqual([
      "active",
      "paused",
      "cancelled",
    ]);
    expect(rows[0]?.body).toMatchObject({
      alfredAccountId: ACC,
      tierRef: "aerwell-continuum",
      paid: true,
      periodEnd: null,
    });
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(3);
  });
  it("sends nothing when the flag is off or the member has no Alfred account", async () => {
    (env as { ALFRED_PLAN_GRANTS_ENABLED: string }).ALFRED_PLAN_GRANTS_ENABLED = "false";
    await hold("aerwell-essential");
    expect(await PlanGrantOutbox.countDocuments()).toBe(0);
    (env as { ALFRED_PLAN_GRANTS_ENABLED: string }).ALFRED_PLAN_GRANTS_ENABLED = "true";
    member = await memberRow();
    await hold("aerwell-essential");
    expect(await PlanGrantOutbox.countDocuments()).toBe(0);
  });
});

describe("one active membership per member", () => {
  it("ends the previous active membership when staff grant another plan", async () => {
    await hold("aerwell-essential");
    await hold("aerwell-continuum");
    const rows = await MemberMembership.find({ memberId: member._id }).lean();
    expect(rows.filter((r) => r.status !== "cancelled")).toHaveLength(1);
    expect(rows.find((r) => r.status === "cancelled")?.cancelledAt).toBeTruthy();
  });
});

describe("Stripe refusal", () => {
  it("refuses a staff grant while Alfred records an active card subscription", async () => {
    await Member.updateOne(
      { _id: member._id },
      {
        alfredMembership: {
          tierKey: "aerwell-continuum",
          status: "active",
          source: "stripe",
          updatedAt: new Date(),
        },
      }
    );
    const res = await hold("aerwell-essential");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PLAN_PAID_SUBSCRIPTION_ACTIVE");
    expect(res.body.message).toBe(
      "Member pays for Aerwell Continuum by card in Alfred. Cancel that subscription first."
    );
    expect(await MemberMembership.countDocuments()).toBe(0);
    await Member.updateOne({ _id: member._id }, { "alfredMembership.source": "admin" });
    expect((await hold("aerwell-essential")).status).toBe(201);
  });
});

describe("inbound setMembership", () => {
  afterEach(removeAlfredKeys);
  const push = (body: Record<string, unknown>) =>
    alfredClient(app).post(`/members/${ACCOUNT}/membership`, body);
  beforeEach(async () => {
    installAlfredKeys();
    await Member.deleteMany({});
    member = await memberRow({ alfredAccountId: ACCOUNT });
  });
  const rows = () => MemberMembership.find({ memberId: member._id }).sort({ createdAt: 1 }).lean();

  it("creates, updates, suspends and cancels a local row marked alfred, never queueing", async () => {
    const until = "2030-01-01T00:00:00.000Z";
    expect(
      (await push({ tierKey: "aerwell-essential", status: "active", source: "admin" })).status
    ).toBe(200);
    let [row] = await rows();
    expect(row).toMatchObject({ source: "alfred", status: "active", endsAt: null });
    expect((await Member.findById(member._id).lean())?.alfredMembership?.source).toBe("admin");
    await push({ tierKey: "aerwell-essential", status: "active", source: "stripe" });
    expect((await Member.findById(member._id).lean())?.alfredMembership?.source).toBe("stripe");
    await push({ tierKey: "aerwell-essential", status: "active", validUntil: until });
    await push({ tierKey: "aerwell-essential", status: "active", validUntil: until });
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]?.endsAt).toEqual(new Date(until));
    await push({ tierKey: "aerwell-essential", status: "suspended" });
    expect((await rows())[0]?.status).toBe("paused");
    await push({ tierKey: "aerwell-continuum", status: "active" });
    const after = await rows();
    expect(after.map((r) => r.status)).toEqual(["cancelled", "active"]);
    await push({ tierKey: "aerwell-continuum", status: "cancelled" });
    [row] = (await rows()).slice(1);
    expect(row?.status).toBe("cancelled");
    expect(await PlanGrantOutbox.countDocuments()).toBe(0);
  });
  it("keeps bundled and unknown keys record-only", async () => {
    await push({ tierKey: "bundled", status: "active" });
    await push({ tierKey: "nope", status: "active" });
    expect(await rows()).toHaveLength(0);
    expect((await Member.findById(member._id).lean())?.alfredMembership?.tierKey).toBe("nope");
  });
});

describe("publisher", () => {
  const NOW = new Date("2027-03-01T20:00:00.000Z");
  function fakeAlfred(statuses: number[], code?: string) {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
      [];
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
      if (String(url).endsWith("/oauth/token"))
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 300 }), {
          status: 200,
        });
      calls.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      const status = statuses.shift() ?? 200;
      return new Response(JSON.stringify({ data: code ? { code } : {} }), { status });
    });
    return calls;
  }
  const seed = () => hold("aerwell-essential");
  const only = () => PlanGrantOutbox.findOne().lean();

  it("posts to Alfred with the partner token and marks sent", async () => {
    await seed();
    const calls = fakeAlfred([200]);
    expect(await drainPlanGrants(NOW)).toEqual({ sent: 1, failed: 0, dead: 0 });
    expect(calls[0]?.url).toBe("https://alfred.test/internal/plan-grants");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer tok");
    expect(calls[0]?.body).toMatchObject({
      alfredAccountId: ACC,
      tierRef: "aerwell-essential",
      status: "active",
    });
    expect((await only())?.status).toBe("sent");
  });
  it("dead-letters a 409 PLAN_PAID_SUBSCRIPTION_ACTIVE with the reason stored", async () => {
    await seed();
    fakeAlfred([409], "PLAN_PAID_SUBSCRIPTION_ACTIVE");
    expect((await drainPlanGrants(NOW)).dead).toBe(1);
    const row = await only();
    expect(row).toMatchObject({ status: "dead", lastStatusCode: 409 });
    expect(row?.lastError).toContain("PLAN_PAID_SUBSCRIPTION_ACTIVE");
  });
  it("retries a 503 (same eventId in flight) and accepts the 200 answer arrays", async () => {
    await seed();
    fakeAlfred([503]);
    expect((await drainPlanGrants(NOW)).failed).toBe(1);
    expect(await only()).toMatchObject({ status: "failed", lastStatusCode: 503 });
    await PlanGrantOutbox.updateOne({}, { nextAttemptAt: new Date(0) });
    vi.stubGlobal("fetch", async (url: string | URL) =>
      String(url).endsWith("/oauth/token")
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 300 }))
        : new Response(JSON.stringify({ data: { granted: [], paused: [], revoked: [] } }))
    );
    expect((await drainPlanGrants(NOW)).sent).toBe(1);
  });
  it("dead-letters a 400 and retries a 500 with backoff", async () => {
    await seed();
    fakeAlfred([400]);
    expect((await drainPlanGrants(NOW)).dead).toBe(1);
    await PlanGrantOutbox.deleteMany({});
    await MemberMembership.deleteMany({});
    await seed();
    fakeAlfred([500]);
    expect((await drainPlanGrants(NOW)).failed).toBe(1);
    const row = await only();
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());
  });
});
