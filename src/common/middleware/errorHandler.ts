import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../errors/AppError.js";
import { ServiceResponse } from "../models/serviceResponse.js";
import { logger } from "../utils/logger.js";

const knownErrorResponse = (err: Error): ServiceResponse<unknown> | undefined => {
  if (err.name === "ValidationError") return ServiceResponse.badRequest("Validation failed");
  if (err.name === "CastError") return ServiceResponse.badRequest("Invalid ID format");
  if ("code" in err && err.code === 11000)
    return ServiceResponse.error("Resource already exists", null, 409);
  if (err.name === "JsonWebTokenError") return ServiceResponse.unauthorized("Invalid token");
  if (err.name === "TokenExpiredError") return ServiceResponse.unauthorized("Token expired");
  if ("type" in err && err.type === "entity.parse.failed")
    return ServiceResponse.badRequest("Invalid JSON body");
  if ("type" in err && err.type === "entity.too.large")
    return ServiceResponse.error("Request body too large", null, 413);
  return undefined;
};

export const errorHandler: ErrorRequestHandler = (
  err: Error | AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  logger.error({ errorType: err.name }, "Request failed");
  if (err instanceof AppError) {
    res
      .status(err.statusCode)
      .json(ServiceResponse.error(err.message, err.data ?? null, err.statusCode, err.code));
    return;
  }
  if (err instanceof ZodError) {
    const errors = err.errors.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    res.status(400).json(ServiceResponse.badRequest("Validation failed", errors));
    return;
  }
  const known = knownErrorResponse(err);
  if (known) {
    res.status(known.statusCode).json(known);
    return;
  }
  const message = env.NODE_ENV === "production" ? "Internal server error" : err.message;
  res.status(500).json(ServiceResponse.error(message));
};
