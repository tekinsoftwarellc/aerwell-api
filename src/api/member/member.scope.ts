import type { Request } from "express";
import type { FilterQuery } from "mongoose";
import { ConflictError, ForbiddenError, NotFoundError } from "../../common/errors/AppError.js";
import { actor } from "../../common/http.js";
import { permits, resolvePermissions } from "../role/permission.js";
import type { EffectivePermissions, PermissionModule } from "../role/permission.types.js";
import { Member, type MemberData } from "./member.model.js";

export async function permissionsOf(req: Request): Promise<EffectivePermissions> {
  req.permissions ??= await resolvePermissions(actor(req));
  return req.permissions;
}
/**
 * Org + own-scope filter for member reads. "own" on MEMBER_RECORDS, or on any
 * extra module the route is guarded by (notes, billing), limits the actor to
 * members whose assignedClinicianIds include them.
 */
export async function memberScope(
  req: Request,
  modules: PermissionModule[] = []
): Promise<FilterQuery<MemberData>> {
  const staff = actor(req);
  const permissions = await permissionsOf(req);
  if (!permits(permissions.MEMBER_RECORDS.level, "view")) throw new ForbiddenError();
  const own = ["MEMBER_RECORDS" as const, ...modules].some((m) => permissions[m].scope === "own");
  return {
    organizationId: staff.organizationId,
    ...(own ? { assignedClinicianIds: staff._id } : {}),
  };
}
export async function isOwnScope(req: Request) {
  return (await permissionsOf(req)).MEMBER_RECORDS.scope === "own";
}
/** The member in :id, or 404 when outside the org or the actor's scope. */
export async function memberTarget(
  req: Request,
  { write = false, modules = [] as PermissionModule[] } = {}
) {
  const member = await Member.findOne({
    _id: req.params["id"],
    ...(await memberScope(req, modules)),
  });
  if (!member) throw new NotFoundError("Member not found");
  if (write && member.archivedAt)
    throw new ConflictError("Archived members cannot be changed", undefined, "MEMBER_ARCHIVED");
  return member;
}
