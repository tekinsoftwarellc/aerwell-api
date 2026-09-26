import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { swaggerSpec } from "./config/swagger.js";
import { createServer } from "./server.js";

/**
 * Drift guard: every `METHOD /path` mounted on the express app must appear in
 * the hand-maintained OpenAPI spec, and vice versa. Hand-written specs rot —
 * this is the mechanical check that they haven't.
 *
 * Deliberate omissions go in ALLOWLIST with a one-line reason. Anything else
 * failing here is a real documentation gap: fix the spec, not the test.
 */
const ALLOWLIST = new Set<string>();

/** `app._router.stack` layer → mount path, e.g. `/internal/accounts/{id}`. */
const mountPath = (layer: {
  regexp: RegExp & { fast_slash?: boolean };
  keys?: Array<{ name: string | number }>;
}): string => {
  if (layer.regexp.fast_slash) return "";
  const keys = layer.keys ?? [];
  let i = 0;
  return (
    layer.regexp.source
      .replace(/^\^/, "")
      .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
      .replace(/\\\/\?\$$/, "")
      .replace(/\$$/, "")
      // `(?:\/([^/]+?))` is how express 4 encodes a `:param` in a MOUNT path.
      .replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, () => `/{${String(keys[i++]?.name ?? "param")}}`)
      .replace(/\\(.)/g, "$1")
  );
};

/** Every `METHOD /path` the app actually serves. */
const mountedOperations = (app: Express): Set<string> => {
  const found = new Set<string>();
  const walk = (stack: unknown[], prefix: string): void => {
    for (const raw of stack) {
      const layer = raw as {
        name: string;
        route?: { path: string; methods: Record<string, boolean> };
        handle?: { stack?: unknown[] };
        regexp: RegExp & { fast_slash?: boolean };
        keys?: Array<{ name: string | number }>;
      };
      if (layer.route) {
        const path = normalise(prefix + layer.route.path);
        for (const method of Object.keys(layer.route.methods)) {
          found.add(`${method.toUpperCase()} ${path}`);
        }
      } else if (layer.name === "router" && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: express 4 exposes the router privately.
  walk((app as any)._router.stack, "");
  return found;
};

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

/** `/api/v1/auth/member/:id/` → `/api/v1/auth/member/{id}`; `:key(*)` → `{key}`. */
const normalise = (path: string): string => {
  const withBraces = path.replace(/:([A-Za-z0-9_]+)(\([^)]*\))?/g, "{$1}");
  return withBraces.length > 1 ? withBraces.replace(/\/+$/, "") : withBraces;
};

describe("swagger spec vs mounted routes", () => {
  const mounted = mountedOperations(createServer());
  const documented = documentedOperations(swaggerSpec);

  it("documents every mounted route", () => {
    const undocumented = [...mounted].filter((p) => !documented.has(p) && !ALLOWLIST.has(p));
    expect(undocumented.sort()).toEqual([]);
  });

  it("documents no route that is not mounted", () => {
    const phantom = [...documented].filter((p) => !mounted.has(p));
    expect(phantom.sort()).toEqual([]);
  });
});
