import type { NextFunction, Request, Response } from "express";
import { ForbiddenError } from "../errors/AppError.js";

declare global {
  namespace Express {
    interface Request {
      organizationId?: string;
    }
  }
}

/**
 * Ensures req.organizationId is set for organization-scoped routes.
 * Must be applied AFTER authenticate middleware.
 *
 * Super admins operating cross-organization must provide `x-organization-id` header.
 */
export const requireOrganizationScope = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  if (!req.organizationId) {
    next(
      new ForbiddenError(
        "Organization context is required for this operation. " +
          "Super admins must provide x-organization-id header for cross-organization access."
      )
    );
    return;
  }
  next();
};
