import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { createServer } from "../../server.js";
import { client, idOf, memberRow, staffWith } from "../../test/memberFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { Role } from "../role/role.model.js";
vi.mock("../../common/services/serviceTokenClient.js", () => ({
  ALFRED_TIMEOUT_MS: 5000,
  getServiceToken: vi.fn(async () => "service-token"),
}));
const savedUrl = env.ALFRED_API_INTERNAL_URL;
let app: ReturnType<typeof createServer>;
let upstream: ReturnType<typeof vi.fn>;
beforeEach(() => {
  app = createServer();
  env.ALFRED_API_INTERNAL_URL = "https://alfred.test";
  upstream = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ data: { intake: { status: "completed", detailsRestricted: true } } }),
        { status: 200 }
      )
  );
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => {
  env.ALFRED_API_INTERNAL_URL = savedUrl;
  vi.unstubAllGlobals();
});
it("requires member-record permission and denies foreign members without calling Alfred", async () => {
  const fixture = await staffWith({ MEMBER_RECORDS: "view" });
  const staff = client(app, fixture.accessToken);
  expect(
    (
      await staff.get(
        `/members/${idOf(await memberRow({ organizationId: "foreign", alfredAccountId: "acct" }))}/health-intake`
      )
    ).status
  ).toBe(404);
  const none = client(app, (await staffWith({ HEALTH_INTAKE: "view" })).accessToken);
  expect((await none.get(`/members/${idOf(await memberRow())}/health-intake`)).status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
});
it("resolves stable link and ignores claimed permissions/account IDs", async () => {
  const fixture = await staffWith({ MEMBER_RECORDS: "view" });
  const member = await memberRow({ alfredAccountId: "stable-account" });
  const res = await client(app, fixture.accessToken)
    .get(`/members/${idOf(member)}/health-intake`)
    .set("x-health-intake-detail", "true")
    .set("x-health-intake-staff-id", "forged");
  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain("/stable-account/health-intake");
  expect(init.headers).toMatchObject({
    "x-health-intake-detail": "false",
    "x-health-intake-staff-id": String(fixture.staff._id),
  });
});
it("enforces dedicated own assignment restrictions and forwards authorized detail", async () => {
  const fixture = await staffWith({ MEMBER_RECORDS: "view", HEALTH_INTAKE: "view" });
  await Role.updateOne(
    { _id: fixture.role._id, "permissions.module": "HEALTH_INTAKE" },
    { $set: { "permissions.$.scope": "own" } }
  );
  const staff = client(app, fixture.accessToken);
  expect(
    (
      await staff.get(
        `/members/${idOf(await memberRow({ alfredAccountId: "other" }))}/health-intake`
      )
    ).status
  ).toBe(404);
  const member = await memberRow({
    alfredAccountId: "own",
    assignedClinicianIds: [fixture.staff._id],
  });
  expect((await staff.get(`/members/${idOf(member)}/health-intake`)).status).toBe(200);
  expect((upstream.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({
    "x-health-intake-detail": "true",
  });
});
it("requires explicit health permission even for super admins, never caches authorization", async () => {
  const fixture = await staffFixture(true);
  const member = await memberRow({ alfredAccountId: "account" });
  const staff = client(app, fixture.accessToken);
  await staff.get(`/members/${idOf(member)}/health-intake`);
  expect((upstream.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({
    "x-health-intake-detail": "false",
  });
  upstream.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        data: { intake: { authorization: { state: "withdrawn" }, detailsRestricted: true } },
      })
    )
  );
  const res = await staff.get(`/members/${idOf(member)}/health-intake`);
  expect(res.body.data.intake.authorization.state).toBe("withdrawn");
  expect(upstream).toHaveBeenCalledTimes(2);
});
it("returns unlinked and fails closed on upstream errors without a mirror fallback", async () => {
  const staff = client(app, (await staffWith({ MEMBER_RECORDS: "view" })).accessToken);
  const unlinked = await staff.get(`/members/${idOf(await memberRow())}/health-intake`);
  expect(unlinked.body.data).toEqual({ intake: null, reason: "MEMBER_NOT_LINKED" });
  upstream.mockResolvedValueOnce(new Response("private health data", { status: 500 }));
  expect(
    (
      await staff.get(
        `/members/${idOf(await memberRow({ alfredAccountId: "account" }))}/health-intake`
      )
    ).status
  ).toBe(503);
});

it("rechecks a revoked dedicated role grant on the next request", async () => {
  const fixture = await staffWith({ MEMBER_RECORDS: "view", HEALTH_INTAKE: "view" });
  const member = await memberRow({ alfredAccountId: "account" });
  const staff = client(app, fixture.accessToken);
  upstream.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            intake: {
              authorization: { state: "authorized" },
              detailsRestricted: false,
              questions: [{ value: "revocation sentinel" }],
            },
          },
        })
      )
  );
  expect(
    JSON.stringify((await staff.get(`/members/${idOf(member)}/health-intake`)).body)
  ).toContain("revocation sentinel");
  await Role.updateOne(
    { _id: fixture.role._id, "permissions.module": "HEALTH_INTAKE" },
    { $set: { "permissions.$.level": "none" } }
  );
  const next = await staff.get(`/members/${idOf(member)}/health-intake`);
  expect(next.status).toBe(200);
  expect(JSON.stringify(next.body)).not.toContain("revocation sentinel");
  expect((upstream.mock.calls.at(-1) as unknown as [string, RequestInit])[1].headers).toMatchObject(
    {
      "x-health-intake-detail": "false",
    }
  );
});
