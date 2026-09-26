import { describe, expect, it } from "vitest";
import { swaggerSpec } from "./config/swagger.js";
import { createServer } from "./server.js";
import { PUBLIC_ROUTES, mountedRoutes } from "./test/routes.js";

/**
 * Drift guard: every `METHOD /path` mounted on the express app must appear in
 * the hand-maintained OpenAPI spec, and vice versa. Hand-written specs rot —
 * this is the mechanical check that they haven't.
 *
 * Deliberate omissions go in ALLOWLIST with a one-line reason. Anything else
 * failing here is a real documentation gap: fix the spec, not the test.
 */
const ALLOWLIST = new Set<string>();

/** Every `METHOD /path` the OpenAPI spec claims. */
const documentedOperations = (spec: { paths?: Record<string, unknown> }): Set<string> => {
  const found = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(item as Record<string, unknown>)) {
      if (["get", "post", "put", "patch", "delete"].includes(method)) {
        found.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return found;
};

describe("swagger spec vs mounted routes", () => {
  const mounted = new Set(mountedRoutes(createServer()).map((r) => r.operation));
  const documented = documentedOperations(swaggerSpec);

  it("documents every mounted route", () => {
    const undocumented = [...mounted].filter((p) => !(documented.has(p) || ALLOWLIST.has(p)));
    expect(undocumented.sort()).toEqual([]);
  });

  it("documents public routes as public and every other route as bearer-secured", () => {
    const paths = (
      swaggerSpec as { paths: Record<string, Record<string, { security?: unknown[] }>> }
    ).paths;
    const wrong = [...mounted].filter((op) => {
      const [method = "", path = ""] = op.split(" ");
      const security = paths[path]?.[method.toLowerCase()]?.security ?? [];
      return PUBLIC_ROUTES.has(op) ? security.length > 0 : security.length === 0;
    });
    expect(wrong.sort()).toEqual([]);
  });

  it("documents no route that is not mounted", () => {
    const phantom = [...documented].filter((p) => !mounted.has(p));
    expect(phantom.sort()).toEqual([]);
  });
});
