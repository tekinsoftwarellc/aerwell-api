import mongoose from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";
import "../server.js";
import { eraseMember } from "./erase-member.js";
import { ERASURE_MAP, type ErasureEntry, LINK_FIELDS, entryOf } from "./erase-member.map.js";

type Oid = mongoose.Types.ObjectId;
type Row = Record<string, unknown>;
interface Person {
  id: Oid;
  alfred: string | undefined;
}

const oid = () => new mongoose.Types.ObjectId();
const MARKERS = ["ERASE-NAME-7f3", "erase-7f3@example.test", "+15550007f3"];
const MARK = MARKERS.join(" ");
const PAST = new Date("2020-01-01");
const ORG = "org-test";

function rc(target: ErasureEntry | string) {
  const db = mongoose.connection.db;
  if (!db) throw new Error("not connected");
  return db.collection(typeof target === "string" ? target : target.collection);
}
const entries = (...cls: string[]) =>
  Object.entries(ERASURE_MAP).filter(([, e]) => cls.length === 0 || cls.includes(e.class));
const doErase = (p: Person, confirm = true) => eraseMember(p.alfred ?? String(p.id), { confirm });

/** Raw inserts skip validators, so fill every unique-index key the fixture left empty. */
async function uniqueFilled(e: ErasureEntry, row: Row): Promise<Row> {
  const indexes = await rc(e)
    .indexes()
    .catch(() => []);
  let out = row;
  for (const ix of indexes) {
    if (!ix["unique"] || ix["name"] === "_id_") continue;
    for (const path of Object.keys(ix["key"] as object)) {
      if (!(path in out)) out = { ...out, [path]: String(oid()) };
    }
  }
  return out;
}

async function seedMember(
  marked: boolean,
  opts: { linked?: boolean; id?: Oid } = {}
): Promise<Person> {
  const id = opts.id ?? oid();
  const alfred = opts.linked === false ? undefined : String(oid());
  const n = marked ? MARKERS : ["Other", "other@example.test", "+15559990000"];
  await rc("members").insertOne({
    _id: id,
    organizationId: ORG,
    ...(alfred ? { alfredAccountId: alfred } : {}),
    firstName: n[0],
    lastName: n[0],
    email: `${String(id)}.${n[1]}`,
    phone: n[2],
    dateOfBirth: new Date("1990-01-01"),
    sex: "female",
    address: { city: n[0] },
    emergencyContact: { name: n[0] },
    intakeNote: n[0],
    status: "active",
    processorCustomerId: `cus_${String(id)}`,
    photoUploadId: id,
  });
  await rc("uploadrecords").insertOne({ _id: id, key: `photos/${String(id)}.png` });
  return { id, alfred };
}

function rowFor(name: string, e: ErasureEntry, p: Person, mark: string): Row {
  const base: Row = { organizationId: ORG, memberId: p.id, pii: mark };
  const special = new Map<string, Row>([
    [
      "AuditEvent",
      {
        ...base,
        memberId: String(p.id),
        actorId: "s",
        action: "x",
        targetType: "Member",
        targetId: "t",
      },
    ],
    ["Appointment", { ...base, status: "completed", startAt: PAST }],
    [
      "SupplementOrder",
      { organizationId: ORG, memberId: p.id, status: "closed", noteToMember: mark },
    ],
    [
      "ProductOrder",
      {
        organizationId: ORG,
        memberId: p.id,
        accountId: p.alfred,
        status: "delivered",
        shippingAddress: { line1: mark },
      },
    ],
    [
      "PartnerOutbox",
      { accountId: p.alfred ?? String(p.id), status: "sent", payload: { n: mark } },
    ],
  ]);
  const plain: Row =
    e.class === "keep:payment" ? { organizationId: ORG, memberId: p.id, status: "closed" } : base;
  return special.get(name) ?? plain;
}

async function seedRows(p: Person, mark: string, clinical: boolean): Promise<void> {
  const skip = clinical ? ["notMember"] : ["notMember", "keep:clinical"];
  for (const [name, e] of entries()) {
    if (skip.includes(e.class) || e.class === "pseudonymise") continue;
    await rc(e).insertOne(await uniqueFilled(e, rowFor(name, e, p, mark)));
  }
}

async function dump(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [name, e] of entries()) out[name] = await rc(e).find({}).sort({ _id: 1 }).toArray();
  return out;
}
const countsOf = async (cls: string[]) => {
  const out: Record<string, number> = {};
  for (const [name, e] of entries(...cls)) out[name] = await rc(e).countDocuments({});
  return out;
};
const sans = (rows: unknown[], keys: string[]) =>
  rows.filter((r) => !keys.some((k) => JSON.stringify(r).includes(k)));

describe("erase:member (aerwell)", () => {
  let clinical: Person; // has clinical rows: retained, not pseudonymised
  let plain: Person; // none: pseudonymised
  let bystander: Person;
  beforeEach(async () => {
    clinical = await seedMember(true);
    plain = await seedMember(true);
    bystander = await seedMember(false);
    await seedRows(clinical, MARK, true);
    await seedRows(plain, MARK, false);
    await seedRows(bystander, "bystander-text", true);
  });

  it("every model with a link field is classified", () => {
    const models = Object.values(mongoose.connection.models);
    const linked = models.filter((m) => LINK_FIELDS.some((f) => m.schema.path(f)));
    expect(linked.filter((m) => !ERASURE_MAP[m.modelName]).map((m) => m.modelName)).toEqual([]);
    for (const [name, e] of entries()) {
      const model = mongoose.connection.models[name];
      expect(model?.collection.collectionName, name).toBe(e.collection);
      if (e.class === "notMember") expect(e.reason, name).toBeTruthy();
    }
  });

  it("dry run writes nothing", async () => {
    const before = await dump();
    const r = await doErase(plain, false);
    expect(await dump()).toEqual(before);
    expect(r.matchedBy).toBe("alfredAccountId");
    expect(r.counts["paymentmethods"]).toBe(1);
  });

  it("confirm erases, pseudonymises and keeps (member without clinical rows)", async () => {
    await doErase(plain);
    for (const [name, e] of entries("erase")) {
      expect(await rc(e).countDocuments({ memberId: plain.id }), name).toBe(0);
    }
    for (const [name, e] of entries("keep:audit", "keep:payment")) {
      const link = e.by[0] ?? "memberId";
      const want =
        link === "accountId" ? (plain.alfred ?? "") : { $in: [plain.id, String(plain.id)] };
      expect(await rc(e).countDocuments({ [link]: want }), name).toBeGreaterThan(0);
    }
    const m = await rc("members").findOne({ _id: plain.id });
    expect(m).toMatchObject({
      firstName: "Erased",
      alfredAccountId: plain.alfred,
      organizationId: ORG,
    });
    for (const f of [
      "lastName",
      "email",
      "phone",
      "address",
      "emergencyContact",
      "intakeNote",
      "photoUploadId",
    ]) {
      expect(m?.[f], f).toBeUndefined();
    }
    expect(m?.["archivedAt"]).toBeInstanceOf(Date);
    expect(m?.["processorCustomerId"]).toBeDefined();
  });

  it("clinical rows are never deleted: kept, marked retained, member not pseudonymised", async () => {
    const before = await countsOf(["keep:clinical"]);
    const r = await doErase(clinical);
    expect(r.clinicalRetained).toBe(true);
    expect(await countsOf(["keep:clinical"])).toEqual(before);
    for (const [name, e] of entries("keep:clinical")) {
      const unmarked = await rc(e).countDocuments({
        memberId: clinical.id,
        erasureRetainedAt: { $exists: false },
      });
      expect(unmarked, name).toBe(0);
    }
    const m = await rc("members").findOne({ _id: clinical.id });
    expect(m).toMatchObject({ firstName: MARKERS[0], lastName: MARKERS[0], sex: "female" });
    expect(m?.["dateOfBirth"]).toBeInstanceOf(Date);
    // Contact, address, emergency contact, intake note and photo do not identify the record.
    for (const f of ["email", "phone", "address", "emergencyContact", "intakeNote", "photoUploadId"])
      expect(m?.[f], f).toBeUndefined();
    expect(await rc("uploadrecords").countDocuments({ _id: clinical.id })).toBe(0);
    expect(m?.["erasureRetainedAt"]).toBeInstanceOf(Date);
    expect(m?.["archivedAt"]).toBeInstanceOf(Date);
    // Non-clinical content of the same member is still erased.
    expect(await rc(entryOf("AlfredDraft")).countDocuments({ memberId: clinical.id })).toBe(0);
  });

  it("append-only hooks do not block the raw audit row or the erasure", async () => {
    await doErase(plain);
    const rows = await rc("auditevents")
      .find({ action: "member.erase", memberId: String(plain.id) })
      .toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: "script:erase-member", organizationId: ORG });
  });

  it("bystander untouched", async () => {
    const before = await dump();
    await doErase(plain);
    await doErase(clinical);
    const after = await dump();
    const mine = [
      String(plain.id),
      String(clinical.id),
      plain.alfred ?? "",
      clinical.alfred ?? "",
      MARKERS[1] ?? "",
    ];
    for (const [name, rows] of Object.entries(before)) {
      const notErasureAudit = (r: unknown) => !JSON.stringify(r).includes("member.erase");
      expect(sans(after[name] ?? [], mine).filter(notErasureAudit), name).toEqual(sans(rows, mine));
    }
    expect(await rc("members").findOne({ _id: bystander.id })).toMatchObject({
      firstName: "Other",
    });
  });

  it("no marker outside audit and clinical", async () => {
    await doErase(plain);
    await doErase(clinical);
    // Member is checked separately: the clinical person keeps identity by design.
    const exempt = new Set(["Member", ...entries("keep:audit", "keep:clinical").map(([n]) => n)]);
    const text = JSON.stringify(Object.entries(await dump()).filter(([n]) => !exempt.has(n)));
    const members = JSON.stringify(await rc("members").find({ _id: plain.id }).toArray());
    const uploads = JSON.stringify(await rc("uploadrecords").find({ _id: plain.id }).toArray());
    for (const m of MARKERS) {
      const hit = Object.entries(await dump())
        .filter(([n, r]) => !exempt.has(n) && JSON.stringify(r).includes(m))
        .map(([n]) => n);
      expect(hit, m).toEqual([]);
      expect(text).not.toContain(m);
      expect(members).not.toContain(m);
    }
    expect(uploads).toBe("[]");
  });

  it("photo key is listed, not deleted by the script", async () => {
    const r = await doErase(plain, false);
    expect(r.s3Keys).toEqual([`photos/${String(plain.id)}.png`]);
  });

  it("link match wins over _id fallback", async () => {
    const trap = await seedMember(false, {
      linked: false,
      id: new mongoose.Types.ObjectId(plain.alfred),
    });
    await doErase(plain);
    expect(await rc("members").findOne({ _id: trap.id })).toMatchObject({ firstName: "Other" });
  });

  it("unlinked member erased by _id", async () => {
    const u = await seedMember(true, { linked: false });
    const r = await doErase(u);
    expect(r.matchedBy).toBe("_id");
    expect(await rc("members").findOne({ _id: u.id })).toMatchObject({ firstName: "Erased" });
    expect(await rc("members").findOne({ _id: plain.id })).toMatchObject({ firstName: MARKERS[0] });
  });

  it("confirm refuses with a blocker (future appointment) and changes nothing", async () => {
    await rc("appointments").insertOne({
      organizationId: ORG,
      memberId: plain.id,
      status: "booked",
      startAt: new Date(Date.now() + 86_400_000),
    });
    const before = await dump();
    await expect(doErase(plain)).rejects.toMatchObject({ code: "ERASE_BLOCKED" });
    expect(await dump()).toEqual(before);
    expect((await doErase(plain, false)).blockers.length).toBeGreaterThan(0);
  });

  it("a live capture lease blocks", async () => {
    const appt = await rc("appointments").findOne({ memberId: clinical.id });
    await rc("visitcaptureleases").insertOne({
      _id: appt?.["_id"],
      captureId: "c1",
      heartbeatAt: new Date(),
      captureCount: 1,
    });
    await expect(doErase(clinical)).rejects.toMatchObject({ code: "ERASE_BLOCKED" });
  });

  it("pending outbox rows and active memberships block", async () => {
    await rc("partner_outbox").insertOne({ accountId: plain.alfred, status: "pending" });
    await expect(doErase(plain)).rejects.toMatchObject({ code: "ERASE_BLOCKED" });
    await rc("partner_outbox").deleteMany({ status: "pending" });
    await rc("membermemberships").insertOne({ memberId: plain.id, status: "active" });
    await expect(doErase(plain)).rejects.toMatchObject({ code: "ERASE_BLOCKED" });
  });

  it("second confirm reports zeroes and adds no audit row", async () => {
    await doErase(plain);
    await doErase(clinical);
    const audits = await rc("auditevents").countDocuments({ action: "member.erase" });
    for (const p of [plain, clinical]) {
      const r = await doErase(p);
      expect(Object.values(r.counts).every((n) => n === 0)).toBe(true);
    }
    expect(await rc("auditevents").countDocuments({ action: "member.erase" })).toBe(audits);
    expect(audits).toBe(2);
  });
});
