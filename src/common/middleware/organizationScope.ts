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
 * Requires the fixed Aerwell organization context populated by authentication.
 * W1 authentication must validate it against AERWELL_ORG_ID and the staff record;
 * caller-supplied headers never select a different organization.
 */
export const requireOrganizationScope = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  if (!req.organizationId) {
    next(new ForbiddenError("Aerwell organization context is required for this operation."));
    return;
  }
  next();
};
