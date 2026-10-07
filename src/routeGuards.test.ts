import { describe, expect, it } from "vitest";
import { PARTNER_PATH } from "./api/alfred-partner/partner.paths.js";
import { createServer } from "./server.js";
import { PUBLIC_ROUTES as PUBLIC, mountedRoutes } from "./test/routes.js";

/**
 * Every mounted route must authenticate, check a permission and validate its
 * input with Zod — unless it is listed below with the reason it is exempt.
 * A new route that forgets a guard fails here, not in production.
 */
/** Raw-body or input-less routes. */
const NO_ZOD = new Set([
  "GET /api/v1/health",
  "GET /api/v1/health/live",
  "GET /api/v1/health/ready",
  "POST /api/v1/webhooks/stripe",
]);
/** Signed-in staff acting on their own data, or routes that check permissions per item inside. */
const SELF_SCOPED = new Set([
  "GET /api/v1/me",
  "GET /api/v1/me/counters",
  "GET /api/v1/permissions/modules",
  "POST /api/v1/auth/change-password",
  "GET /api/v1/me/notification-preferences",
  "PUT /api/v1/me/notification-preferences",
  "GET /api/v1/me/view-preferences/{context}",
  "PUT /api/v1/me/view-preferences/{context}",
  "GET /api/v1/notifications",
  "POST /api/v1/notifications/read-all",
  "POST /api/v1/notifications/{id}/read",
  // Own PTO request; approval is permission-checked.
  "POST /api/v1/staff/pto-requests",
  // Location list/environments are org reference data every staff member books against.
  "GET /api/v1/locations",
  "GET /api/v1/locations/{id}/environments",
  // Checks the permission of the upload purpose inside the handler.
  "POST /api/v1/uploads/presign",
  // Widgets are built from routes the caller could call (each checked as the caller).
  "GET /api/v1/dashboard/summary",
  "GET /api/v1/dashboard/agenda",
  "GET /api/v1/dashboard/outlook",
  // Alfred: own conversations/drafts only; every tool runs the target route's guard.
  "GET /api/v1/alfred/config",
  "GET /api/v1/alfred/conversations",
  "POST /api/v1/alfred/conversations",
  "GET /api/v1/alfred/conversations/{id}/messages",
  "POST /api/v1/alfred/conversations/{id}/messages",
  "GET /api/v1/alfred/drafts/{draftId}",
  "POST /api/v1/alfred/drafts/{draftId}/confirm",
  "POST /api/v1/alfred/drafts/{draftId}/cancel",
  "GET /api/v1/alfred/suggestions",
  "POST /api/v1/alfred/suggestions",
  "POST /api/v1/alfred/suggestions/{sid}/action",
]);

describe("route guards", () => {
  const all = mountedRoutes(createServer());
  // Alfred's partner surface (contract v1) has its own guard and no staff session.
  const isPartner = (chain: string[]) => chain.includes("alfredServiceAuth");
  const routes = all.filter((r) => !isPartner(r.chain));
  const missing = (test: (chain: string[]) => boolean, exempt: Set<string>) =>
    routes
      .filter((r) => !(exempt.has(r.operation) || test(r.chain)))
      .map((r) => r.operation)
      .sort();

  it("finds the mounted routes", () => {
    expect(routes.length).toBeGreaterThan(150);
  });
  it("authenticates every non-public route", () => {
    expect(missing((c) => c.includes("authenticate"), PUBLIC)).toEqual([]);
  });
  it("checks a permission on every staff route", () => {
    expect(
      missing((c) => c.includes("permissionGuard"), new Set([...PUBLIC, ...SELF_SCOPED]))
    ).toEqual([]);
  });
  it("validates every route's input with Zod", () => {
    expect(missing((c) => c.includes("zodValidate"), NO_ZOD)).toEqual([]);
  });
  it("rate limits every public sign-in flow", () => {
    const auth = routes.filter((r) => r.operation.startsWith("POST /api/v1/auth/"));
    const unlimited = auth
      .filter((r) => r.operation !== "POST /api/v1/auth/change-password")
      // One scopedRateLimit is the global per-IP limiter; the route needs its own too.
      .filter((r) => r.chain.filter((name) => name === "scopedRateLimit").length < 2)
      .map((r) => r.operation);
    expect(unlimited).toEqual([]);
  });
  it("guards every Alfred partner route with the service token and zod, never staff auth", () => {
    const partner = all.filter((r) => isPartner(r.chain));
    expect(partner.filter((r) => r.chain.includes("authenticate")).map((r) => r.operation)).toEqual(
      []
    );
    expect(partner.filter((r) => !r.chain.includes("zodValidate")).map((r) => r.operation)).toEqual(
      []
    );
    expect(
      partner.filter((r) => !r.chain.includes("requireContractVersion")).map((r) => r.operation)
    ).toEqual([]);
  });
  it("acts for the member on both clinical report routes", () => {
    const report = all.filter((r) => r.operation.includes("/alfred/clinical/reports/"));
    expect(report.map((r) => r.operation).sort()).toEqual([
      "GET /api/v1/alfred/clinical/reports/{reportRef}",
      "POST /api/v1/alfred/clinical/reports/{reportRef}/export",
    ]);
    for (const r of report) {
      expect(r.chain).toContain("requireMemberAct");
      expect(r.chain).toContain("resolveActingMember");
    }
  });
  it("leaves no route on a partner path without the service-token guard", () => {
    const unguarded = all
      .filter((r) => PARTNER_PATH.test(r.operation.split(" ")[1] ?? "") && !isPartner(r.chain))
      .map((r) => r.operation);
    expect(unguarded).toEqual([]);
  });
  it("keeps every exemption pointing at a real route", () => {
    const ops = new Set(routes.map((r) => r.operation));
    const stale = [...PUBLIC, ...NO_ZOD, ...SELF_SCOPED].filter((op) => !ops.has(op));
    expect(stale).toEqual([]);
  });
});
