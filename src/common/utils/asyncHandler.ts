import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRequestHandler = (
  // biome-ignore lint/suspicious/noExplicitAny: Express Request generics require `any` for controller compatibility
  req: Request<any, any, any, any>,
  res: Response,
  next: NextFunction
) => Promise<void>;

export const asyncHandler = (fn: AsyncRequestHandler): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
