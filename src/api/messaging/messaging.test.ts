import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearServiceTokenCache } from "../../common/services/serviceTokenClient.js";
import { idOf, memberRow, staffWith } from "../../test/memberFixture.js";
import { as } from "../../test/scheduleFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { Notification } from "../notification/notification.model.js";
import { pollMemberMessages } from "./messaging.poller.js";

/** Log capture: the body sentinel must never appear in any log line (also checked below). */
const sink = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../../common/utils/logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../common/utils/logger.js")>();
  return {
    ...real,
    logger: real.createLogger({ write: (l: string) => sink.lines.push(l) } as never),
  };
});

const BODY = "BODY-SENTINEL-8841";
const thread = (id: string, accountId: string, unread = 1, at = "2026-10-07T10:00:00.000Z") => ({
  id,
  accountId,
  orgId: "o",
  staff: { ref: "inbox", name: "Aerwell", role: "" },
  lastMessagePreview: BODY,
  lastMessageAt: at,
  unreadForMember: 0,
  unreadForStaff: unread,
  createdAt: at,
});
const page = (items: unknown[]) => ({
  items,
  total: items.length,
  page: 1,
  limit: 100,
  totalPages: 1,
});

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}
/** A scripted Alfred: the token endpoint answers; messaging routes follow `route`. */
function fakeAlfred(route: (c: Call) => { status: number; data?: unknown } | Error) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    if (String(url).endsWith("/oauth/token"))
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 300 }));
    const call: Call = {
      method: init.method ?? "GET",
      url: String(url),
      body: init.body ? JSON.parse(String(init.body)) : null,
      headers: init.headers as Record<string, string>,
    };
    calls.push(call);
    const answer = route(call);
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify({ data: answer.data }), { status: answer.status });
  });
  return calls;
}

beforeEach(() => {
  sink.lines.length = 0;
  clearServiceTokenCache();
});
afterEach(() => vi.unstubAllGlobals());

async function world() {
  const mine = await memberRow({ alfredAccountId: "acct-mine" });
  const other = await memberRow({ alfredAccountId: "acct-other" });
  const doc = await staffWith({ MEMBER_RECORDS: "edit" }, "own");
  await mine.updateOne({ assignedClinicianIds: [doc.staff._id] });
  const boss = await staffWith({ MEMBER_RECORDS: "edit" });
  const viewer = await staffWith({ MEMBER_RECORDS: "view" });
  return { mine, other, doc, boss, viewer, api: as(doc.accessToken) };
}
const threads = [thread("t-mine", "acct-mine", 2), thread("t-other", "acct-other", 1)];
const listRoute = (c: Call) => {
  if (c.url.includes("/threads?")) {
    const account = new URL(c.url).searchParams.get("accountId");
    return {
      status: 200,
      data: page(account ? threads.filter((t) => t.accountId === account) : threads),
    };
  }
  if (c.url.endsWith("/messages") && c.method === "GET")
    return { status: 200, data: page([{ id: "m1", body: BODY, sender: "member" }]) };
  if (c.url.endsWith("/messages")) return { status: 201, data: { id: "m2", sender: "staff" } };
  return { status: 200, data: { threadId: "t-mine", unreadForStaff: 0 } };
};

describe("staff messaging routes", () => {
  it("lists only in-scope threads with the Aerwell member name; all-scope sees both", async () => {
    const w = await world();
    fakeAlfred(listRoute);
    const own = await w.api.get("/api/v1/messaging/threads");
    expect(own.status).toBe(200);
    expect(own.body.data.items.map((t: { id: string }) => t.id)).toEqual(["t-mine"]);
    expect(own.body.data.items[0]).toMatchObject({
      memberId: idOf(w.mine),
      memberName: `${w.mine.firstName} ${w.mine.lastName}`,
      unreadForStaff: 2,
    });
    const all = await as(w.boss.accessToken).get("/api/v1/messaging/threads");
    expect(all.body.data.items).toHaveLength(2);
    const count = await w.api.get("/api/v1/messaging/unread-count");
    expect(count.body.data).toEqual({ unreadThreads: 1, unreadMessages: 2 });
  });

  it("cannot read, send or mark read on a thread of a member outside scope (404, no Alfred send)", async () => {
    const w = await world();
    const calls = fakeAlfred(listRoute);
    const q = `?memberId=${idOf(w.other)}`;
    expect((await w.api.get(`/api/v1/messaging/threads/t-other/messages${q}`)).status).toBe(404);
    const send = await w.api.post("/api/v1/messaging/threads/t-other/messages", {
      memberId: idOf(w.other),
      body: BODY,
    });
    expect(send.status).toBe(404);
    const read = await w.api.post("/api/v1/messaging/threads/t-other/read", {
      memberId: idOf(w.other),
    });
    expect(read.status).toBe(404);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("refuses a thread id that does not belong to that member", async () => {
    const w = await world();
    fakeAlfred(listRoute);
    const res = await as(w.boss.accessToken).get(
      `/api/v1/messaging/threads/t-other/messages?memberId=${idOf(w.mine)}`
    );
    expect(res.status).toBe(404);
  });

  it("replies as the staff actor with the right scope, audits ids only and logs no body", async () => {
    const w = await world();
    const calls = fakeAlfred(listRoute);
    const res = await w.api.post("/api/v1/messaging/threads/t-mine/messages", {
      memberId: idOf(w.mine),
      body: BODY,
    });
    expect(res.status).toBe(201);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("https://alfred.test/api/v1/partner/messaging/threads/t-mine/messages");
    expect(post?.headers["x-contract-version"]).toBe("1");
    expect(post?.body).toEqual({
      actor: { staffRef: String(w.doc.staff._id), name: "Test Actor", role: expect.any(String) },
      body: BODY,
    });
    const events = await AuditEvent.find({ targetType: "Message" }).lean();
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(BODY);
    await w.api.get(`/api/v1/messaging/threads/t-mine/messages?memberId=${idOf(w.mine)}`);
    expect(sink.lines.join("\n")).not.toContain(BODY);
  });

  it("a view-only member-records role can read but not reply or mark read", async () => {
    const w = await world();
    fakeAlfred(listRoute);
    const v = as(w.viewer.accessToken);
    expect((await v.get("/api/v1/messaging/threads")).status).toBe(200);
    const body = { memberId: idOf(w.mine), body: "x" };
    expect((await v.post("/api/v1/messaging/threads/t-mine/messages", body)).status).toBe(403);
    expect(
      (await v.post("/api/v1/messaging/threads/t-mine/read", { memberId: idOf(w.mine) })).status
    ).toBe(403);
  });

  it("answers 503 ALFRED_UNAVAILABLE when Alfred is down, 5xx, or rejects our credentials", async () => {
    const w = await world();
    for (const route of [
      () => new Error("socket"),
      () => ({ status: 502 }),
      () => ({ status: 403 }),
      () => ({ status: 401 }),
    ]) {
      fakeAlfred(route);
      const res = await w.api.get("/api/v1/messaging/threads");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("ALFRED_UNAVAILABLE");
    }
  });

  it("relays an Alfred refusal's status and code, never its text", async () => {
    const w = await world();
    fakeAlfred((c) =>
      c.method === "POST" ? { status: 409, data: { code: "STAFF_MISMATCH" } } : listRoute(c)
    );
    const res = await w.api.post("/api/v1/messaging/threads/t-mine/messages", {
      memberId: idOf(w.mine),
      body: "hi",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STAFF_MISMATCH");
  });

  it("retries a GET once and never a POST", async () => {
    const w = await world();
    let gets = 0;
    fakeAlfred((c) => (c.method === "GET" && gets++ === 0 ? { status: 503 } : listRoute(c)));
    expect((await w.api.get("/api/v1/messaging/threads")).status).toBe(200);
    const posts = fakeAlfred((c) => (c.method === "POST" ? { status: 503 } : listRoute(c)));
    const res = await w.api.post("/api/v1/messaging/threads/t-mine/messages", {
      memberId: idOf(w.mine),
      body: "hi",
    });
    expect(res.status).toBe(503);
    expect(posts.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("validates the body: empty, over 2000 characters and unknown keys are 400", async () => {
    const w = await world();
    fakeAlfred(listRoute);
    const url = "/api/v1/messaging/threads/t-mine/messages";
    const memberId = idOf(w.mine);
    for (const bad of [
      { memberId, body: "   " },
      { memberId, body: "x".repeat(2001) },
      { memberId, body: "hi", attachments: [] },
    ])
      expect((await w.api.post(url, bad)).status).toBe(400);
  });
});

describe("inbound message poller", () => {
  it("raises one generic notice per new message, none twice, with no content", async () => {
    const w = await world();
    fakeAlfred(listRoute);
    expect(await pollMemberMessages("org-test")).toBe(2);
    await pollMemberMessages("org-test");
    const rows = await Notification.find({ kind: "member_message" }).lean();
    // t-mine: the assigned clinician (own scope). t-other has no assigned clinician: the all-scope fallback holders.
    expect(rows.every((r) => r.title === "New member message")).toBe(true);
    const mine = rows.filter((r) => String(r.recipientStaffId) === String(w.doc.staff._id));
    expect(mine).toHaveLength(1);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(BODY);
    expect(serialized).not.toContain(w.mine.firstName);
    const count = rows.length;
    // A newer message on the same thread raises a fresh notice.
    threads[0] = thread("t-mine", "acct-mine", 3, "2026-10-07T10:05:00.000Z");
    await pollMemberMessages("org-test");
    expect(await Notification.countDocuments({ kind: "member_message" })).toBeGreaterThan(count);
    threads[0] = thread("t-mine", "acct-mine", 2);
  });

  it("raises nothing for a read thread", async () => {
    await world();
    fakeAlfred(() => ({ status: 200, data: page([thread("t1", "acct-mine", 0)]) }));
    expect(await pollMemberMessages("org-test")).toBe(0);
  });
});
