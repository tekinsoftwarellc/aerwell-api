import type { NextFunction, Request, Response } from "express";
import { ZodObject, type ZodSchema } from "zod";
import { ServiceResponse } from "../models/serviceResponse.js";

type ValidationTarget = "body" | "query" | "params";
interface ValidateOptions {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

function resolveSchemas(schema: ZodSchema | ValidateOptions): ValidateOptions {
  if (schema instanceof ZodObject) {
    const shape = schema.shape as ValidateOptions;
    if (shape.body || shape.query || shape.params) {
      return { body: shape.body, query: shape.query, params: shape.params };
    }
    return { body: schema };
  }
  if (!("_def" in schema)) return schema;
  return { body: schema as ZodSchema };
}

export const validate = (schema: ZodSchema | ValidateOptions) => {
  // Named so the route-guard test can see it in every chain.
  return function zodValidate(req: Request, res: Response, next: NextFunction): void {
    const errors: { path: string; message: string }[] = [];
    for (const [target, targetSchema] of Object.entries(resolveSchemas(schema)) as [
      ValidationTarget,
      ZodSchema | undefined,
    ][]) {
      if (!targetSchema) continue;
      const result = targetSchema.safeParse(req[target]);
      if (!result.success) {
        errors.push(
          ...result.error.issues.map((issue) => ({
            path: [target, ...issue.path].join("."),
            message: issue.message,
          }))
        );
      } else {
        req[target] = result.data;
      }
    }
    if (errors.length) {
      res.status(400).json(ServiceResponse.badRequest("Validation failed", errors));
      return;
    }
    next();
  };
};
