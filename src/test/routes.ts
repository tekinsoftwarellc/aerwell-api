import type { Express } from "express";

/**
 * Walks the private Express 4 router stack. Shared by the swagger drift test and
 * the route-guard test so both judge the same set of mounted routes.
 */
interface Layer {
  name: string;
  route?: { path: string; methods: Record<string, boolean>; stack: Layer[] };
  handle?: { stack?: Layer[] };
  // biome-ignore lint/style/useNamingConvention: private Express 4 router field.
  regexp: RegExp & { fast_slash?: boolean };
  keys?: Array<{ name: string | number }>;
}
export interface MountedRoute {
  /** `GET /api/v1/members/{id}` */
  operation: string;
  /** Names of every handler that runs for this route, in order (router-level `use` included). */
  chain: string[];
}

/** `app._router.stack` layer → mount path, e.g. `/internal/accounts/{id}`. */
const mountPath = (layer: Layer): string => {
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

/** `/api/v1/auth/member/:id/` → `/api/v1/auth/member/{id}`; `:key(*)` → `{key}`. */
export const normalise = (path: string): string => {
  const withBraces = path.replace(/:([A-Za-z0-9_]+)(\([^)]*\))?/g, "{$1}");
  return withBraces.length > 1 ? withBraces.replace(/\/+$/, "") : withBraces;
};

/** A concrete path a router-level `use` regexp can be tested against. */
const sample = (path: string) =>
  path.replace(/:[A-Za-z0-9_]+(\([^)]*\))?/g, "000000000000000000000000");

export function mountedRoutes(app: Express): MountedRoute[] {
  const found: MountedRoute[] = [];
  const walk = (stack: Layer[], prefix: string, inherited: string[]): void => {
    const before: Layer[] = [];
    for (const layer of stack) {
      if (layer.route) {
        const applied = before.filter((u) => u.regexp.test(sample(layer.route?.path ?? "")));
        const chain = [
          ...inherited,
          ...applied.map((u) => u.name),
          ...layer.route.stack.map((s) => s.name),
        ];
        const path = normalise(prefix + layer.route.path);
        for (const method of Object.keys(layer.route.methods))
          found.push({ operation: `${method.toUpperCase()} ${path}`, chain });
      } else if (layer.name === "router" && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer), [
          ...inherited,
          ...before.filter((u) => u.regexp.fast_slash).map((u) => u.name),
        ]);
      } else before.push(layer);
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: express 4 exposes the router privately.
  walk((app as any)._router.stack, "", []);
  return found;
}

/** Routes that deliberately take no staff session (route-guard + OpenAPI tests). */
export const PUBLIC_ROUTES = new Set([
  // Health probes carry no data and take no input.
  "GET /api/v1/health",
  "GET /api/v1/health/live",
  "GET /api/v1/health/ready",
  // Pre-sign-in flows: rate limited and Zod validated (routeGuards.test.ts).
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/refresh",
  "POST /api/v1/auth/logout",
  "POST /api/v1/auth/2fa/verify",
  "POST /api/v1/auth/forgot-password",
  "POST /api/v1/auth/reset-password",
  "POST /api/v1/auth/accept-invite",
  // Authenticated by the Stripe signature over the raw body.
  "POST /api/v1/webhooks/stripe",
]);
