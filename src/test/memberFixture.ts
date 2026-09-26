import type { Types } from "mongoose";
import request from "supertest";
import { Member } from "../api/member/member.model.js";
import type { PermissionLevel, PermissionModule } from "../api/role/permission.types.js";
import { Role } from "../api/role/role.model.js";
import type { createServer } from "../server.js";
import { staffFixture } from "./staffFixture.js";

export const ORG = "org-test";
let counter = 0;
/** Synthetic member row written directly (bypasses the API). */
export async function memberRow(fields: Record<string, unknown> = {}) {
  counter += 1;
  return Member.create({
    organizationId: ORG,
    firstName: `First${counter}`,
    lastName: `Last${counter}`,
    email: `member-${counter}-${Math.random()}@example.invalid`,
    ...fields,
  });
}
/**
 * Staff whose role grants exactly `grants` (every other module none).
 * `scope` applies to every granted module.
 */
export async function staffWith(
  grants: Partial<Record<PermissionModule, PermissionLevel>>,
  scope: "all" | "own" = "all"
) {
  const fixture = await staffFixture(false);
  const permissions = fixture.role.permissions.map((p) => ({
    module: p.module,
    level: grants[p.module as PermissionModule] ?? "none",
    scope,
  }));
  await Role.updateOne({ _id: fixture.role._id }, { $set: { permissions } });
  return fixture;
}
export function client(app: ReturnType<typeof createServer>, token: string) {
  const auth = { authorization: `Bearer ${token}` };
  return {
    get: (path: string) => request(app).get(`/api/v1${path}`).set(auth),
    send: (method: "post" | "patch" | "put", path: string, body: unknown = {}) =>
      request(app)
        [method](`/api/v1${path}`)
        .set(auth)
        .send(body as object),
  };
}
export const idOf = (doc: { _id: Types.ObjectId }) => String(doc._id);
