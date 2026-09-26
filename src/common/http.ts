import type { Request, Router } from "express";
import type { ZodTypeAny } from "zod";
import { z } from "zod";
import type { PermissionLevel, PermissionModule } from "../api/role/permission.types.js";
import type { StaffDocument } from "../api/staff/staff.model.js";
import { UnauthorizedError } from "./errors/AppError.js";
import { authenticate } from "./middleware/authenticate.js";
import { requirePermission } from "./middleware/permission.js";
import { validate } from "./middleware/validate.js";
import { ServiceResponse } from "./models/serviceResponse.js";
import { asyncHandler } from "./utils/asyncHandler.js";
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid identifier");
export const idParams = z.object({ id: objectId }).strict();
export const empty = z.object({}).strict();
export const nonEmptyPatch = <T extends ZodTypeAny>(schema: T) =>
  schema.refine((v) => Object.keys(v).length > 0, "Provide at least one field");
export function actor(req: Request): StaffDocument {
  if (!req.staff) throw new UnauthorizedError();
  return req.staff;
}
export function secured(
  router: Router,
  method: "get" | "post" | "patch" | "put" | "delete",
  path: string,
  permission: { module: PermissionModule; level: PermissionLevel } | null,
  schema: { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny },
  handler: (req: Request) => Promise<unknown>,
  status = 200
) {
  const guard = permission ? [requirePermission(permission.module, permission.level)] : [];
  router[method](
    path,
    authenticate,
    ...guard,
    validate({
      body: schema.body ?? empty,
      query: schema.query ?? empty,
      params: schema.params ?? empty,
    }),
    asyncHandler(async (req, res) => {
      const result = await handler(req);
      res.status(status).json(ServiceResponse.success("OK", result, status));
    })
  );
}
export function pagination(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  };
}
export const escapedSearch = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
