import type { Request, Response } from "express";
import type { ZodTypeAny } from "zod";
import { type RouteSpec, empty, routeRegistry } from "../../common/http.js";
import { errorHandler } from "../../common/middleware/errorHandler.js";
import { permits, resolvePermissions } from "../role/permission.js";
import type { StaffDocument } from "../staff/staff.model.js";

/**
 * Runs a mounted route's own guard, schema and handler in-process, as the acting
 * staff member. It is the only way Alfred AI reads or writes anything, so a tool
 * gets exactly what that person would get over HTTP: the same permission level,
 * the same own scope, the same validation, and the same audit rows (handlers
 * audit their own reads and writes).
 */
export interface Actor {
  staff: StaffDocument;
  requestId?: string | undefined;
}
export interface RouteInput {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}
export type RouteOutcome =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code: string; message: string; issues?: unknown };

export function routeSpec(key: string): RouteSpec {
  const spec = routeRegistry.get(key);
  if (!spec) throw new Error(`Unknown route ${key}`);
  return spec;
}

/** HTTP query values are strings; send tool arguments the same way. */
const asQuery = (query: Record<string, unknown> = {}) =>
  Object.fromEntries(
    Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)])
  );

/** Maps an error exactly as the HTTP error handler would. */
function failure(error: unknown): RouteFailure {
  const captured = { status: 500, body: {} as Record<string, unknown> };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return res;
    },
  } as unknown as Response;
  errorHandler(error as Error, {} as Request, res, () => undefined);
  return {
    ok: false,
    status: captured.status,
    code: String(captured.body["code"] ?? "INTERNAL_ERROR"),
    message: String(captured.body["message"] ?? "Request failed"),
    ...(captured.body["data"] ? { issues: captured.body["data"] } : {}),
  };
}

export type RouteFailure = Extract<RouteOutcome, { ok: false }>;
type Prepared = { ok: true; req: Request; spec: RouteSpec } | RouteFailure;

/** Guard + validation only (what `secured` runs before the handler). */
export async function prepareRoute(
  actor: Actor,
  key: string,
  input: RouteInput
): Promise<Prepared> {
  const spec = routeSpec(key);
  const req = {
    staff: actor.staff,
    organizationId: actor.staff.organizationId,
    requestId: actor.requestId,
    params: input.params ?? {},
    query: asQuery(input.query),
    body: input.body ?? {},
    headers: {},
  } as unknown as Request;
  try {
    if (spec.permission) {
      const resolved = await resolvePermissions(actor.staff);
      if (!permits(resolved[spec.permission.module].level, spec.permission.level))
        return { ok: false, status: 403, code: "FORBIDDEN", message: "Forbidden" };
      req.permissions = resolved;
      req.permission = resolved[spec.permission.module];
    }
  } catch (error) {
    return failure(error);
  }
  const issues: { path: string; message: string }[] = [];
  for (const target of ["params", "query", "body"] as const) {
    const schema: ZodTypeAny = spec.schema[target] ?? empty;
    const parsed = schema.safeParse(req[target]);
    if (parsed.success) req[target] = parsed.data;
    else
      issues.push(
        ...parsed.error.issues.map((issue) => ({
          path: [target, ...issue.path].join("."),
          message: issue.message,
        }))
      );
  }
  if (issues.length)
    return {
      ok: false,
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      issues,
    };
  return { ok: true, req, spec };
}

export async function callRoute(
  actor: Actor,
  key: string,
  input: RouteInput
): Promise<RouteOutcome> {
  const prepared = await prepareRoute(actor, key, input);
  if (!("req" in prepared)) return prepared;
  try {
    return { ok: true, data: await prepared.spec.handler(prepared.req) };
  } catch (error) {
    return failure(error);
  }
}
