import { randomUUID } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../common/middleware/errorHandler.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { createServer } from "../../server.js";
import {
  ACCOUNT,
  alfredToken,
  installAlfredKeys,
  removeAlfredKeys,
} from "../../test/partnerFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { alfredServiceAuth, requireContractVersion, requireMemberAct } from "./partnerAuth.js";

/** A probe route behind the real guards: the ten rules of contract §2.2, one test each. */
const probe = express();
probe.use(express.json());
probe.get("/org", alfredServiceAuth, requireContractVersion, (req, res) => {
  res.json(ServiceResponse.success("ok", { accountId: req.partner?.accountId ?? null }));
});
probe.get("/member", alfredServiceAuth, requireContractVersion, requireMemberAct, (req, res) => {
  res.json(ServiceResponse.success("ok", { accountId: req.partner?.accountId }));
});
probe.use(errorHandler);
const call = (token: string, path = "/org", version: string | null = "1") => {
  const r = request(probe).get(path).set("authorization", `Bearer ${token}`);
  return version === null ? r : r.set("x-contract-version", version);
};

beforeEach(installAlfredKeys);
afterEach(removeAlfredKeys);

describe("alfredServiceAuth: the ten rules", () => {
  it("accepts a valid token and trusts act only after every check", async () => {
    const res = await call(alfredToken(), "/member");
    expect(res.status).toBe(200);
    expect(res.body.data.accountId).toBe(ACCOUNT);
    expect(res.headers["x-contract-version"]).toBe("1");
  });
  it("401 without a bearer token", async () => {
    const res = await request(probe).get("/org").set("x-contract-version", "1");
    expect(res.status).toBe(401);
  });
  it("rule 1: rejects HS256 and alg none, even with a plausible kid", async () => {
    const hs = jwt.sign(
      { realm: "service", svc: "alfred-api", scope: "partner.read" },
      "x".repeat(40),
      {
        algorithm: "HS256",
        issuer: "alfred-auth",
        audience: "partner-aerwell",
        keyid: "alfred-test-kid",
      }
    );
    expect((await call(hs)).status).toBe(401);
    const none = `${Buffer.from('{"alg":"none","kid":"alfred-test-kid"}').toString("base64url")}.${Buffer.from(
      JSON.stringify({
        iss: "alfred-auth",
        aud: "partner-aerwell",
        realm: "service",
        svc: "alfred-api",
        scope: "partner.read",
      })
    ).toString("base64url")}.`;
    expect((await call(none)).status).toBe(401);
  });
  it("rule 1: a staff session token (HS256) never passes", async () => {
    const { accessToken } = await staffFixture(false, 0);
    expect((await call(accessToken)).status).toBe(401);
  });
  it("rule 2: unknown kid, missing kid and a bad signature are 401; an unreachable JWKS is 503", async () => {
    expect((await call(alfredToken({ header: { keyid: "rotated-away" } }))).status).toBe(401);
    const noKid = alfredToken({ header: { keyid: null } });
    expect((await call(noKid)).status).toBe(401);
    // A change in the middle of the signature: the last base64url character carries unused bits, so
    // flipping it can leave the decoded signature (and the verdict) unchanged.
    const [head, body, sig = ""] = alfredToken().split(".");
    const mid = Math.floor(sig.length / 2);
    const tampered = [
      head,
      body,
      `${sig.slice(0, mid)}${sig[mid] === "A" ? "B" : "A"}${sig.slice(mid + 1)}`,
    ].join(".");
    expect((await call(tampered)).status).toBe(401);
    const { setAlfredKeyProvider } = await import("../../common/utils/alfredJwks.js");
    setAlfredKeyProvider(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await call(alfredToken())).status).toBe(503);
  });
  it("rule 3: wrong issuer is 401", async () => {
    expect((await call(alfredToken({ header: { issuer: "someone-else" } }))).status).toBe(401);
  });
  it("rule 4: another partner's audience is 401", async () => {
    expect((await call(alfredToken({ header: { audience: "partner-everhaus" } }))).status).toBe(
      401
    );
  });
  it("rule 5: a member-realm token is 401", async () => {
    expect((await call(alfredToken({ claims: { realm: "member" } }))).status).toBe(401);
  });
  it("rule 6: any svc but alfred-api is 401", async () => {
    expect((await call(alfredToken({ claims: { svc: "other-svc" } }))).status).toBe(401);
  });
  it("rule 7: a missing scope is 403 with no data.code", async () => {
    const res = await call(alfredToken({ claims: { scope: "partner.tools.execute" } }));
    expect(res.status).toBe(403);
    expect(res.body.data).toBeNull();
  });
  it("rule 8: 60 s of clock tolerance, no more", async () => {
    expect((await call(alfredToken({ expiresIn: -30 }))).status).toBe(200);
    expect((await call(alfredToken({ expiresIn: -120 }))).status).toBe(401);
  });
  it("rule 9: act.orgId of another org is 403 ORG_MISMATCH", async () => {
    const token = alfredToken({
      claims: { act: { sub: ACCOUNT, realm: "member", orgId: "other-org" } },
    });
    const res = await call(token);
    expect(res.status).toBe(403);
    expect(res.body.data).toEqual({ code: "ORG_MISMATCH" });
  });
  it("rule 9: an act with no orgId is also a mismatch", async () => {
    const token = alfredToken({ claims: { act: { sub: ACCOUNT, realm: "member" } } });
    expect((await call(token)).status).toBe(403);
  });
  it("rule 10: no act on a member route is 401; on an org route it is fine and ignored", async () => {
    expect((await call(alfredToken({ accountId: null }), "/member")).status).toBe(401);
    expect((await call(alfredToken({ accountId: null }), "/org")).status).toBe(200);
  });
  it("a partner_staff act is never trusted as a member", async () => {
    const token = alfredToken({
      claims: { act: { sub: ACCOUNT, realm: "partner_staff", orgId: "alfred-org-aerwell" } },
    });
    expect((await call(token, "/member")).status).toBe(401);
  });
  it("contract version: missing is 400, anything but 1 is 422", async () => {
    expect((await call(alfredToken(), "/org", null)).status).toBe(400);
    const res = await call(alfredToken(), "/org", "2");
    expect(res.status).toBe(422);
    expect(res.body.data.code).toBe("CONTRACT_VERSION_UNSUPPORTED");
  });
});

describe("partner surface vs staff surface", () => {
  it("an Alfred service token is refused by staff authenticate", async () => {
    const res = await request(createServer())
      .get("/api/v1/me")
      .set("authorization", `Bearer ${alfredToken()}`);
    expect(res.status).toBe(401);
  });
  it("the staff assistant routes on the shared prefix still answer 401 to anonymous callers", async () => {
    const res = await request(createServer()).get(`/api/v1/alfred/config?${randomUUID()}`);
    expect(res.status).toBe(401);
  });
});
