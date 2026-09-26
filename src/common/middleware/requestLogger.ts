import pinoHttp from "pino-http";
import { env } from "../../config/env.js";
import { logger } from "../utils/logger.js";

export const requestLogger = pinoHttp({
  logger,
  autoLogging: env.NODE_ENV !== "test",
  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 500 || err) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage: (req, res) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customProps: (req) => ({
    requestId: (req as unknown as { requestId?: string }).requestId,
    userAgent: req.headers["user-agent"],
  }),
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
});
