import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookingWorld } from "../../test/appointmentFixture.js";
import { memberRow } from "../../test/memberFixture.js";
import {
  ACCOUNT,
  alfredClient,
  alfredToken,
  installAlfredKeys,
  removeAlfredKeys,
} from "../../test/partnerFixture.js";
import { app } from "../../test/scheduleFixture.js";
import { Member, MemberMembership } from "../member/member.model.js";

beforeEach(installAlfredKeys);
afterEach(removeAlfredKeys);
const body = (extra: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT,
  profile: { firstName: "Dana", lastName: "Reyes", dateOfBirth: "1991-04-17", gender: "female" },
  membership: { tierKey: "everhaus", status: "active" },
  ...extra,
});
const client = () => alfredClient(app);

describe("POST /members", () => {
  it("creates an active member with no email, links it by account id, and ignores the membership", async () => {
    const res = await client().post("/members", body());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ created: true });
    const member = await Member.findById(res.body.data.partnerRef).lean();
    expect(member).toMatchObject({
      organizationId: "org-test",
      alfredAccountId: ACCOUNT,
      firstName: "Dana",
      lastName: "Reyes",
      dateOfBirth: "1991-04-17",
      sex: "female",
      status: "active",
    });
    expect(member?.email).toBeUndefined();
    expect(await MemberMembership.countDocuments()).toBe(0);
  });
  it("accepts one name and no profile extras", async () => {
    const res = await client().post("/members", body({ profile: { firstName: "Cher" } }));
    expect(res.status).toBe(201);
    expect(await Member.findById(res.body.data.partnerRef).lean()).toMatchObject({ lastName: "" });
  });
  it("re-provisioning answers 200 with the same ref and updates the profile, never a second record", async () => {
    const first = await client().post("/members", body());
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await client().post(
      "/members",
      body({ profile: { firstName: "Dana", lastName: "Reyes-Smith" } })
    );
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ partnerRef: first.body.data.partnerRef, created: false });
    expect(await Member.countDocuments()).toBe(1);
    expect((await Member.findOne().lean())?.lastName).toBe("Reyes-Smith");
  });
  it("replays the same Idempotency-Key without a second write", async () => {
    const first = await client().post("/members", body(), "prov-key-1");
    const replay = await client().post("/members", body(), "prov-key-1");
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(await Member.countDocuments()).toBe(1);
  });
  it("two provisions of one account in flight make one member", async () => {
    const [a, b] = await Promise.all([
      client().post("/members", body()),
      client().post("/members", body()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await Member.countDocuments({ alfredAccountId: ACCOUNT })).toBe(1);
  });
  it("never links an existing local patient with the same name or birth date", async () => {
    const local = await memberRow({
      firstName: "Dana",
      lastName: "Reyes",
      dateOfBirth: "1991-04-17",
    });
    const res = await client().post("/members", body());
    expect(res.body.data.partnerRef).not.toBe(String(local._id));
    expect((await Member.findById(local._id).lean())?.alfredAccountId).toBeUndefined();
    expect(await Member.countDocuments()).toBe(2);
  });
  it("lets several members without an email coexist, and still enforces email uniqueness", async () => {
    await client().post("/members", body());
    const other = alfredClient(app, alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7a3" }));
    expect(
      (await other.post("/members", body({ accountId: "6710bb4e2f9c1a0031d5e7a3" }))).status
    ).toBe(201);
    await memberRow({ email: "same@example.invalid" });
    await expect(memberRow({ email: "same@example.invalid" })).rejects.toThrow(/duplicate key/);
  });
  it("sets the home location only when it is a real Aerwell location; gender only when it maps", async () => {
    const w = await bookingWorld();
    const ok = await client().post(
      "/members",
      body({
        baseLocationRef: String(w.vegas._id),
        profile: { firstName: "A", gender: "non-binary" },
      })
    );
    const row = await Member.findById(ok.body.data.partnerRef).lean();
    expect(String(row?.homeLocationId)).toBe(String(w.vegas._id));
    expect(row?.sex).toBeUndefined();
    const other = alfredClient(app, alfredToken({ accountId: "6710bb4e2f9c1a0031d5e7a3" }));
    const bad = await other.post(
      "/members",
      body({ accountId: "6710bb4e2f9c1a0031d5e7a3", baseLocationRef: "lab-1" })
    );
    expect(
      (await Member.findById(bad.body.data.partnerRef).lean())?.homeLocationId
    ).toBeUndefined();
  });
  it("is a 409 MEMBER_CONFLICT for an archived record", async () => {
    const first = await client().post("/members", body());
    await Member.updateOne({ _id: first.body.data.partnerRef }, { archivedAt: new Date() });
    const res = await client().post("/members", body());
    expect(res.status).toBe(409);
    expect(res.body.data).toEqual({ code: "MEMBER_CONFLICT" });
  });
  it("is 400 when accountId differs from act.sub, 401 without act, 400 for unknown keys", async () => {
    expect(
      (await client().post("/members", body({ accountId: "6710bb4e2f9c1a0031d5e7a3" }))).status
    ).toBe(400);
    expect(
      (await alfredClient(app, alfredToken({ accountId: null })).post("/members", body())).status
    ).toBe(401);
    expect((await client().post("/members", body({ email: "x@example.invalid" }))).status).toBe(
      400
    );
    expect((await client().post("/members", body({ accountId: "nope" }))).status).toBe(400);
  });
  it("a deleted-then-reprovisioned member is linked again", async () => {
    const first = await client().post("/members", body());
    await Member.updateOne({ _id: first.body.data.partnerRef }, { alfredUnlinkedAt: new Date() });
    await client().post("/members", body());
    expect((await Member.findOne().lean())?.alfredUnlinkedAt).toBeNull();
  });
});
