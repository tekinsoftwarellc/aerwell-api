import { z } from "zod";
import type { StaffData } from "../staff/staff.model.js";
import {
  type EffectivePermissions,
  MODULES,
  type Permission,
  type PermissionLevel,
} from "./permission.types.js";
import { Role } from "./role.model.js";
export { MODULES } from "./permission.types.js";
export const permissionEntry = z
  .object({
    module: z.enum(MODULES),
    level: z.enum(["none", "view", "edit", "master"]),
    scope: z.enum(["all", "own"]).default("all"),
  })
  .strict();
export const permissionSchema = z
  .array(permissionEntry)
  .length(MODULES.length)
  .refine(
    (v) => new Set(v.map((p) => p.module)).size === MODULES.length,
    "Exactly one entry per module is required"
  );
export const overrideSchema = z
  .array(permissionEntry)
  .refine((v) => new Set(v.map((p) => p.module)).size === v.length, "Duplicate override");
const ranks = { none: 0, view: 1, edit: 2, master: 3 };
export const permits = (actual: PermissionLevel, required: PermissionLevel): boolean =>
  ranks[actual] >= ranks[required];
function makeRole(name: string, shortCode: string, levels: PermissionLevel[]) {
  return {
    name,
    shortCode,
    permissions: MODULES.map(
      (module, i): Permission => ({ module, level: levels[i] ?? "none", scope: "all" })
    ),
  };
}
export const seedRoles = [
  makeRole("Medical director", "MD", [
    "master",
    "master",
    "master",
    "master",
    "view",
    "master",
    "master",
    "master",
    "master",
  ]),
  makeRole("Physician / NP", "NP", [
    "edit",
    "edit",
    "edit",
    "edit",
    "none",
    "view",
    "none",
    "view",
    "edit",
  ]),
  makeRole("Registered nurse", "RN", [
    "edit",
    "edit",
    "edit",
    "view",
    "none",
    "view",
    "none",
    "view",
    "edit",
  ]),
  makeRole("Care coordinator", "CC", [
    "edit",
    "view",
    "view",
    "view",
    "view",
    "view",
    "none",
    "view",
    "master",
  ]),
  makeRole("Front desk", "FD", [
    "view",
    "none",
    "none",
    "none",
    "view",
    "view",
    "none",
    "view",
    "edit",
  ]),
];
export async function resolvePermissions(
  staff: Pick<StaffData, "organizationId" | "roleId" | "permissionOverrides" | "isSuperAdmin">
): Promise<EffectivePermissions> {
  const role = staff.roleId
    ? await Role.findOne({ _id: staff.roleId, organizationId: staff.organizationId }).lean()
    : null;
  return Object.fromEntries(
    MODULES.map((module) => {
      if (staff.isSuperAdmin) return [module, { level: "master", scope: "all" }];
      const entry =
        staff.permissionOverrides.find((p) => p.module === module) ??
        role?.permissions.find((p) => p.module === module);
      return [module, { level: entry?.level ?? "none", scope: entry?.scope ?? "all" }];
    })
  ) as EffectivePermissions;
}
