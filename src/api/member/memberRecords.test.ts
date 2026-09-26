import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import { ORG, client, idOf, memberRow, staffWith } from "../../test/memberFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { type MemberDocument, MemberFlag, MemberNote } from "./member.model.js";

let app: ReturnType<typeof createServer>;
let admin: ReturnType<typeof client>;
let member: MemberDocument;
beforeEach(async () => {
  app = createServer();
  admin = client(app, (await staffFixture(true)).accessToken);
  member = await memberRow();
});
const path = (suffix: string, id = idOf(member)) => `/members/${id}${suffix}`;

describe("member flags", () => {
  it("creates, filters by state on both sides and resolves once", async () => {
    const created = await admin.send("post", path("/flags"), {
      category: "allergy",
      title: "Allergy Alert - Latex",
      severity: "urgent",
    });
    expect(created.status).toBe(201);
    await admin.send("post", path("/flags"), { category: "waitlist", title: "Sauna Waitlist" });
    const flagId = created.body.data._id;
    const resolved = await admin.send("post", path(`/flags/${flagId}/resolve`));
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.resolvedAt).toBeTruthy();
    const titles = async (state: string) =>
      (await admin.get(path(`/flags?state=${state}`))).body.data.map(
        (f: { title: string }) => f.title
      );
    expect(await titles("active")).toEqual(["Sauna Waitlist"]);
    expect(await titles("resolved")).toEqual(["Allergy Alert - Latex"]);
    expect((await titles("all")).sort()).toEqual(["Allergy Alert - Latex", "Sauna Waitlist"]);
    const stamp = (await MemberFlag.findById(flagId))?.resolvedAt?.getTime();
    const twice = await admin.send("post", path(`/flags/${flagId}/resolve`));
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe("FLAG_ALREADY_RESOLVED");
    expect((await MemberFlag.findById(flagId))?.resolvedAt?.getTime()).toBe(stamp);
    expect(
      await AuditEvent.countDocuments({ targetType: "MemberFlag", memberId: idOf(member) })
    ).toBe(3);
  });
  it("never resolves another member's flag and requires edit to write", async () => {
    const other = await memberRow();
    const flag = await MemberFlag.create({
      organizationId: ORG,
      memberId: other._id,
      category: "custom",
      title: "Theirs",
      raisedBy: "system",
    });
    expect((await admin.send("post", path(`/flags/${idOf(flag)}/resolve`))).status).toBe(404);
    expect((await MemberFlag.findById(flag._id))?.resolvedAt).toBeNull();
    const viewer = client(app, (await staffWith({ MEMBER_RECORDS: "view" })).accessToken);
    expect((await viewer.get(path("/flags"))).status).toBe(200);
    expect(
      (await viewer.send("post", path("/flags"), { category: "custom", title: "x" })).status
    ).toBe(403);
  });
});

describe("member notes", () => {
  it("requires CLINICAL_NOTES: front desk is denied, nurse can write", async () => {
    const frontDesk = client(
      app,
      (await staffWith({ MEMBER_RECORDS: "view", BILLING: "view" })).accessToken
    );
    expect((await frontDesk.get(path("/notes"))).status).toBe(403);
    expect((await frontDesk.send("post", path("/notes"), { body: "x" })).status).toBe(403);
    const reader = client(
      app,
      (await staffWith({ MEMBER_RECORDS: "view", CLINICAL_NOTES: "view" })).accessToken
    );
    expect((await reader.send("post", path("/notes"), { body: "x" })).status).toBe(403);
    const nurse = client(
      app,
      (await staffWith({ MEMBER_RECORDS: "edit", CLINICAL_NOTES: "edit" })).accessToken
    );
    expect(
      (await nurse.send("post", path("/notes"), { body: "Synthetic observation" })).status
    ).toBe(201);
  });
  it("tracks read state per staff member, idempotently, and audits every read", async () => {
    const author = await staffWith({ MEMBER_RECORDS: "edit", CLINICAL_NOTES: "edit" });
    const writer = client(app, author.accessToken);
    const first = await writer.send("post", path("/notes"), { body: "First synthetic note" });
    await writer.send("post", path("/notes"), { body: "Second synthetic note" });
    const own = await writer.get(path("/notes"));
    expect(own.body.data.newCount).toBe(0);
    expect(own.body.data.items[0].author).toEqual({ name: "Test Actor", titlePrefix: null });
    const reader = await staffWith({ MEMBER_RECORDS: "view", CLINICAL_NOTES: "view" });
    const readerApi = client(app, reader.accessToken);
    const unread = await readerApi.get(path("/notes"));
    expect(unread.body.data.newCount).toBe(2);
    expect(unread.body.data.items.map((n: { body: string }) => n.body)).toEqual([
      "Second synthetic note",
      "First synthetic note",
    ]);
    await readerApi.send("post", path("/notes/read"), { noteIds: [first.body.data._id] });
    expect((await readerApi.get(path("/notes"))).body.data.newCount).toBe(1);
    await readerApi.send("post", path("/notes/read"));
    await readerApi.send("post", path("/notes/read"));
    expect((await readerApi.get(path("/notes"))).body.data.newCount).toBe(0);
    const note = await MemberNote.findById(first.body.data._id);
    expect(note?.readBy.filter((id) => String(id) === String(reader.staff._id))).toHaveLength(1);
    expect(
      await AuditEvent.countDocuments({
        action: "viewed",
        targetType: "MemberNotes",
        memberId: idOf(member),
      })
    ).toBe(4);
  });
  it("marks only this member's notes read", async () => {
    const other = await memberRow();
    const theirs = await admin.send("post", path("/notes", idOf(other)), { body: "Other member" });
    const reader = await staffWith({ MEMBER_RECORDS: "view", CLINICAL_NOTES: "view" });
    await client(app, reader.accessToken).send("post", path("/notes/read"), {
      noteIds: [theirs.body.data._id],
    });
    expect((await MemberNote.findById(theirs.body.data._id))?.readBy.map(String)).not.toContain(
      String(reader.staff._id)
    );
  });
});

describe("view preferences", () => {
  it("defaults, saves per staff member and validates the layout", async () => {
    const initial = await admin.get("/me/view-preferences/member_appointment");
    expect(initial.body.data).toMatchObject({ layout: 1, isDefault: true });
    const saved = await admin.send("put", "/me/view-preferences/member_appointment", {
      layout: 2,
      columns: [
        ["appointment", "health"],
        ["alfred", "notes"],
      ],
    });
    expect(saved.status).toBe(200);
    expect((await admin.get("/me/view-preferences/member_appointment")).body.data).toMatchObject({
      layout: 2,
      isDefault: false,
    });
    const someoneElse = client(app, (await staffWith({})).accessToken);
    expect(
      (await someoneElse.get("/me/view-preferences/member_appointment")).body.data.isDefault
    ).toBe(true);
    for (const body of [
      { layout: 2, columns: [["health"]] },
      { layout: 2, columns: [["health"], ["health"]] },
      { layout: 1, columns: [["unknown"]] },
    ])
      expect(
        (await admin.send("put", "/me/view-preferences/member_appointment", body)).status
      ).toBe(400);
    expect((await admin.get("/me/view-preferences/bogus")).status).toBe(400);
  });
});
