import { Types } from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../server.js";
import { ORG, client, idOf, memberRow, staffWith } from "../../test/memberFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { StaffCredential } from "../auth/auth.model.js";
import { Role } from "../role/role.model.js";
import { UploadRecord } from "../upload/upload.model.js";
import { Member, MemberFlag } from "./member.model.js";

let app: ReturnType<typeof createServer>;
let admin: ReturnType<typeof client>;
let adminId: string;
beforeEach(async () => {
  app = createServer();
  const fixture = await staffFixture(true);
  admin = client(app, fixture.accessToken);
  adminId = String(fixture.staff._id);
});
const person = {
  firstName: "Synthetic",
  lastName: "Person",
  email: "Synthetic.Person@Example.invalid",
  phone: "555-0100",
  dateOfBirth: "1986-08-12",
  sex: "female",
  emergencyContact: { name: "Synthetic Contact", phone: "555-0101" },
};
const names = (res: { body: { data: { items: { lastName: string }[] } } }) =>
  res.body.data.items.map((m) => m.lastName);

describe("create member", () => {
  it("creates an active clinical record without credentials or an Alfred link, and audits it", async () => {
    const credentialsBefore = await StaffCredential.countDocuments();
    const res = await admin.send("post", "/members", { ...person, intakeNote: "Referral" });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("active");
    expect(res.body.data.email).toBe("synthetic.person@example.invalid");
    expect(res.body.data.alfredLink).toEqual({ status: "unlinked", configured: false });
    const row = await Member.findById(res.body.data._id).lean();
    expect(row?.alfredAccountId).toBeUndefined();
    expect(await StaffCredential.countDocuments()).toBe(credentialsBefore);
    expect(Object.keys(res.body.data)).not.toContain("passwordHash");
    expect(
      await AuditEvent.countDocuments({
        action: "created",
        targetType: "Member",
        memberId: res.body.data._id,
      })
    ).toBe(1);
  });
  it("refuses a duplicate email with MEMBER_EMAIL_EXISTS and never creates a second row", async () => {
    await admin.send("post", "/members", person);
    const again = await admin.send("post", "/members", {
      ...person,
      email: "synthetic.person@example.INVALID",
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("MEMBER_EMAIL_EXISTS");
    expect(await Member.countDocuments({ organizationId: ORG })).toBe(1);
  });
  it("rejects identity/credential fields and missing names", async () => {
    for (const extra of [{ alfredAccountId: "acct-1" }, { password: "x" }, { status: "active" }])
      expect((await admin.send("post", "/members", { ...person, ...extra })).status).toBe(400);
    expect((await admin.send("post", "/members", { email: "a@example.invalid" })).status).toBe(400);
    const { phone: _phone, ...noPhone } = person;
    expect((await admin.send("post", "/members", noPhone)).status).toBe(400);
    expect((await admin.send("post", "/members", { ...person, phone: "  " })).status).toBe(400);
  });
  it("requires MEMBER_RECORDS edit to create and view to list", async () => {
    const viewer = client(app, (await staffWith({ MEMBER_RECORDS: "view" })).accessToken);
    expect((await viewer.send("post", "/members", person)).status).toBe(403);
    expect((await viewer.get("/members")).status).toBe(200);
    const none = client(app, (await staffWith({ BILLING: "view" })).accessToken);
    expect((await none.get("/members")).status).toBe(403);
    expect((await none.get(`/members/${idOf(await memberRow())}`)).status).toBe(403);
  });
  it("refuses unknown assigned clinicians and locations before writing", async () => {
    const res = await admin.send("post", "/members", {
      ...person,
      assignedClinicianIds: [String(new Types.ObjectId())],
    });
    expect(res.status).toBe(404);
    expect(await Member.countDocuments()).toBe(0);
    const location = await admin.send("post", "/members", {
      ...person,
      homeLocationId: String(new Types.ObjectId()),
    });
    expect(location.status).toBe(404);
  });
});

describe("member list", () => {
  beforeEach(async () => {
    // Insertion order (and its reverse) differ from the expected lastName order.
    await memberRow({
      firstName: "Beau",
      lastName: "Cooper",
      status: "active",
      lastVisitAt: new Date("2026-09-01"),
    });
    await memberRow({
      firstName: "Shannon",
      lastName: "Ashton",
      status: "active",
      email: "shannon@example.invalid",
      phone: "+15550100",
    });
    await memberRow({
      firstName: "Phil",
      lastName: "Dalton",
      status: "cancellation_requested",
      lastVisitAt: new Date("2026-09-20"),
    });
    await memberRow({
      firstName: "Fryer",
      lastName: "Baker",
      status: "pending_onboarding",
      lastVisitAt: new Date("2026-08-01"),
    });
    await memberRow({
      firstName: "Old",
      lastName: "Archived",
      status: "active",
      archivedAt: new Date(),
    });
  });
  it("sorts by last name by default and by last visit on request", async () => {
    const res = await admin.get("/members");
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(["Ashton", "Baker", "Cooper", "Dalton"]);
    expect(names(await admin.get("/members?sort=-lastVisitAt"))).toEqual([
      "Dalton",
      "Cooper",
      "Baker",
      "Ashton",
    ]);
  });
  it("filters by search, status and flags on both sides, with filtered totals", async () => {
    const search = await admin.get("/members?q=shannon");
    expect(names(search)).toEqual(["Ashton"]);
    expect(search.body.data.items[0].phone).toBe("+15550100");
    expect(search.body.data.pagination.total).toBe(1);
    expect(names(await admin.get("/members?q=zzz-none"))).toEqual([]);
    const status = await admin.get("/members?status[]=active&status[]=pending_onboarding");
    expect(names(status)).toEqual(["Ashton", "Baker", "Cooper"]);
    expect(status.body.data.pagination).toMatchObject({ total: 3, totalPages: 1 });
    const cooper = await Member.findOne({ lastName: "Cooper" });
    const baker = await Member.findOne({ lastName: "Baker" });
    await MemberFlag.create([
      {
        organizationId: ORG,
        memberId: cooper?._id,
        category: "waitlist",
        title: "Sauna Waitlist",
        raisedBy: adminId,
      },
      {
        organizationId: ORG,
        memberId: baker?._id,
        category: "waitlist",
        title: "IV Waitlist",
        raisedBy: adminId,
        resolvedAt: new Date(),
      },
      {
        organizationId: ORG,
        memberId: baker?._id,
        category: "outstanding_balance",
        title: "Balance",
        raisedBy: adminId,
      },
    ]);
    expect(names(await admin.get("/members?flags[]=on_waitlist"))).toEqual(["Cooper"]);
    expect(names(await admin.get("/members?flags[]=outstanding_balance"))).toEqual(["Baker"]);
    expect(names(await admin.get("/members?flags[]=flagged_for_review"))).toEqual([]);
    expect(
      names(await admin.get("/members?flags[]=on_waitlist&status[]=pending_onboarding"))
    ).toEqual([]);
  });
  it("paginates with totals and summarises flags (urgent first)", async () => {
    const page = await admin.get("/members?limit=3&page=2");
    expect(names(page)).toEqual(["Dalton"]);
    expect(page.body.data.pagination).toMatchObject({
      page: 2,
      total: 4,
      totalPages: 2,
      hasPrev: true,
      hasNext: false,
    });
    const ashton = await Member.findOne({ lastName: "Ashton" });
    await MemberFlag.create([
      {
        organizationId: ORG,
        memberId: ashton?._id,
        category: "custom",
        title: "Open one",
        raisedBy: adminId,
        raisedAt: new Date("2026-09-02"),
      },
      {
        organizationId: ORG,
        memberId: ashton?._id,
        category: "clinical",
        title: "Urgent one",
        severity: "urgent",
        raisedBy: adminId,
        raisedAt: new Date("2026-09-01"),
      },
    ]);
    const [first] = (await admin.get("/members")).body.data.items;
    expect(first.flagsSummary).toEqual({ count: 2, primaryLabel: "Urgent one" });
    expect(first).not.toHaveProperty("intakeNote");
  });
  it("audits the directory read", async () => {
    await admin.get("/members");
    expect(
      await AuditEvent.countDocuments({ action: "viewed", targetType: "MemberDirectory" })
    ).toBe(1);
  });
});

describe("own scope (assigned clinician)", () => {
  it("limits list, profile, search and edits to assigned members", async () => {
    const own = await staffWith({ MEMBER_RECORDS: "edit", CLINICAL_NOTES: "edit" }, "own");
    const mine = await memberRow({ lastName: "Mine", assignedClinicianIds: [own.staff._id] });
    const other = await memberRow({ lastName: "Other" });
    const api = client(app, own.accessToken);
    expect(names(await api.get("/members"))).toEqual(["Mine"]);
    expect((await api.get(`/members/${idOf(other)}`)).status).toBe(404);
    expect((await api.get(`/members/${idOf(mine)}`)).status).toBe(200);
    expect((await api.send("patch", `/members/${idOf(other)}`, { phone: "1" })).status).toBe(404);
    expect((await api.get(`/members/${idOf(other)}/notes`)).status).toBe(404);
    expect((await api.get("/members/search?q=Other")).body.data.items).toEqual([]);
    const reassign = await api.send("patch", `/members/${idOf(mine)}`, {
      assignedClinicianIds: [],
    });
    expect(reassign.status).toBe(403);
    expect((await Member.findById(mine._id))?.assignedClinicianIds).toHaveLength(1);
  });
  it("assigns the creating own-scope clinician so the new record stays visible", async () => {
    const own = await staffWith({ MEMBER_RECORDS: "edit" }, "own");
    const res = await client(app, own.accessToken).send("post", "/members", person);
    expect(res.status).toBe(201);
    expect(res.body.data.assignedClinicianIds).toEqual([String(own.staff._id)]);
  });
});

describe("profile, edit and archive", () => {
  it("reads and edits a profile with audit, refusing another org's record", async () => {
    const row = await memberRow({ firstName: "Read", lastName: "Me" });
    const res = await admin.get(`/members/${idOf(row)}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ firstName: "Read", brandLabel: null, photoUrl: null });
    expect(
      await AuditEvent.countDocuments({
        action: "viewed",
        targetType: "Member",
        memberId: idOf(row),
      })
    ).toBe(1);
    const patched = await admin.send("patch", `/members/${idOf(row)}`, {
      phone: "555-0199",
      status: "active",
    });
    expect(patched.body.data).toMatchObject({ phone: "555-0199", status: "active" });
    expect(await AuditEvent.countDocuments({ action: "updated", targetType: "Member" })).toBe(1);
    const foreign = await memberRow({ organizationId: "org-other" });
    expect((await admin.get(`/members/${idOf(foreign)}`)).status).toBe(404);
  });
  it("refuses an email already used by another member", async () => {
    const a = await memberRow({ email: "taken@example.invalid" });
    const b = await memberRow();
    const res = await admin.send("patch", `/members/${idOf(b)}`, {
      email: "taken@example.invalid",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MEMBER_EMAIL_EXISTS");
    expect((await Member.findById(a._id))?.email).toBe("taken@example.invalid");
  });
  it("archives with master only, never deletes, is idempotent and blocks later edits", async () => {
    const a = await memberRow();
    const b = await memberRow();
    const editor = client(app, (await staffWith({ MEMBER_RECORDS: "edit" })).accessToken);
    expect((await editor.send("post", "/members/bulk/archive", { ids: [idOf(a)] })).status).toBe(
      403
    );
    const first = await admin.send("post", "/members/bulk/archive", { ids: [idOf(a), idOf(b)] });
    expect(first.status).toBe(200);
    expect(first.body.data.archived).toBe(2);
    const stamped = (await Member.findById(a._id))?.archivedAt;
    const again = await admin.send("post", "/members/bulk/archive", { ids: [idOf(a)] });
    expect(again.body.data.archived).toBe(0);
    expect((await Member.findById(a._id))?.archivedAt?.getTime()).toBe(stamped?.getTime());
    expect(await Member.countDocuments()).toBe(2);
    expect((await admin.get("/members")).body.data.items).toEqual([]);
    expect((await admin.get(`/members/${idOf(a)}`)).body.data.archivedAt).toBeTruthy();
    const edit = await admin.send("patch", `/members/${idOf(a)}`, { phone: "1" });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("MEMBER_ARCHIVED");
  });
  it("archives nothing when any id is outside the organization or scope", async () => {
    const a = await memberRow();
    const foreign = await memberRow({ organizationId: "org-other" });
    const res = await admin.send("post", "/members/bulk/archive", {
      ids: [idOf(a), idOf(foreign)],
    });
    expect(res.status).toBe(404);
    expect((await Member.findById(a._id))?.archivedAt).toBeNull();
  });
});

describe("member photos", () => {
  it("needs MEMBER_RECORDS edit to presign and refuses to create when storage is unconfigured", async () => {
    const photo = { purpose: "member_photo", contentType: "image/jpeg", sizeBytes: 1000 };
    const viewer = client(app, (await staffWith({ MEMBER_RECORDS: "view" })).accessToken);
    expect((await viewer.send("post", "/uploads/presign", photo)).status).toBe(403);
    const unconfigured = await admin.send("post", "/uploads/presign", photo);
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.code).toBe("STORAGE_UNAVAILABLE");
    const upload = await UploadRecord.create({
      organizationId: ORG,
      uploadedBy: new Types.ObjectId(adminId),
      purpose: "member_photo",
      key: "org-test/member_photo/synthetic",
      contentType: "image/jpeg",
      sizeBytes: 1000,
    });
    const res = await admin.send("post", "/members", { ...person, photoUploadId: idOf(upload) });
    expect(res.status).toBe(503);
    expect(await Member.countDocuments()).toBe(0);
  });
});

describe("review regressions", () => {
  it("applies the CLINICAL_NOTES own scope to the overview notes preview", async () => {
    const mixed = await staffWith({ MEMBER_RECORDS: "view", CLINICAL_NOTES: "view" });
    await Role.updateOne(
      { _id: mixed.role._id, "permissions.module": "CLINICAL_NOTES" },
      { $set: { "permissions.$.scope": "own" } }
    );
    const unassigned = await memberRow();
    const assigned = await memberRow({ assignedClinicianIds: [mixed.staff._id] });
    await admin.send("post", `/members/${idOf(unassigned)}/notes`, { body: "Not yours" });
    const api = client(app, mixed.accessToken);
    expect((await api.get(`/members/${idOf(unassigned)}/overview`)).body.data.notes).toBeNull();
    expect((await api.get(`/members/${idOf(assigned)}/overview`)).body.data.notes).toEqual({
      newCount: 0,
      items: [],
    });
  });
  it("keeps internal fields out of the profile and survives a missing photo upload", async () => {
    const row = await memberRow({
      processorCustomerId: "cus_internal",
      photoUploadId: new Types.ObjectId(),
    });
    const res = await admin.get(`/members/${idOf(row)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.photoUrl).toBeNull();
    expect(res.body.data).not.toHaveProperty("processorCustomerId");
    expect(res.body.data).not.toHaveProperty("membershipRevision");
  });
});

describe("search and overview", () => {
  it("returns a typeahead with brand labels and reports external search as unconfigured", async () => {
    await memberRow({ firstName: "Shannon", lastName: "Ashton" });
    await memberRow({ firstName: "Other", lastName: "Person" });
    const res = await admin.get("/members/search?q=shan");
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([
      expect.objectContaining({ name: "Shannon Ashton", brandLabel: null }),
    ]);
    expect(res.body.data.externalSearch).toBe("unconfigured");
    expect(
      await AuditEvent.countDocuments({ action: "searched", targetType: "MemberDirectory" })
    ).toBe(1);
  });
  it("hides notes from staff without CLINICAL_NOTES and leaves later-wave blocks null", async () => {
    const row = await memberRow();
    const frontDesk = client(app, (await staffWith({ MEMBER_RECORDS: "view" })).accessToken);
    const res = await frontDesk.get(`/members/${idOf(row)}/overview`);
    expect(res.status).toBe(200);
    expect(res.body.data.notes).toBeNull();
    expect(res.body.data).toMatchObject({
      visits: null,
      todayAppointment: null,
      health: null,
      labs: null,
      dexa: null,
    });
    expect(res.body.data.devices).toEqual({ status: "unconfigured", items: [] });
    const full = await admin.get(`/members/${idOf(row)}/overview`);
    expect(full.body.data.notes).toEqual({ newCount: 0, items: [] });
  });
});

describe("Alfred membership record", () => {
  it("is returned on the member profile as a record, absent when never reported", async () => {
    const plain = await memberRow({ firstName: "Plain" });
    expect((await admin.get(`/members/${idOf(plain)}`)).body.data.alfredMembership).toBeUndefined();
    const validUntil = new Date("2027-09-16T00:00:00.000Z");
    const held = await memberRow({
      firstName: "Held",
      alfredMembership: {
        tierKey: "aerwell-essential",
        status: "active",
        validUntil,
        updatedAt: new Date(),
      },
    });
    const res = await admin.get(`/members/${idOf(held)}`);
    expect(res.body.data.alfredMembership).toMatchObject({
      tierKey: "aerwell-essential",
      status: "active",
      validUntil: validUntil.toISOString(),
    });
  });
});
