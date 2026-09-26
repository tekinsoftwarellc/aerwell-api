import type { RequestHandler } from "express";
import { permits, resolvePermissions } from "../../api/role/permission.js";
import type { PermissionLevel, PermissionModule } from "../../api/role/permission.types.js";
import { ForbiddenError, UnauthorizedError } from "../errors/AppError.js";
export const requireStaff: RequestHandler = (req, _res, next) => {
  if (!req.staff) return next(new UnauthorizedError());
  next();
};
export const requirePermission =
  (module: PermissionModule, level: PermissionLevel): RequestHandler =>
  async (req, _res, next) => {
    try {
      if (!req.staff) throw new UnauthorizedError();
      const resolved = await resolvePermissions(req.staff);
      if (!permits(resolved[module].level, level)) throw new ForbiddenError();
      req.permissions = resolved;
      req.permission = resolved[module];
      next();
    } catch (error) {
      next(error);
    }
  };
