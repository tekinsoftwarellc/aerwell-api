import pinoHttp from "pino-http";
import { env } from "../../config/env.js";
import { type Logger, logger } from "../utils/logger.js";

export const createRequestLogger = (log: Logger = logger, autoLogging = env.NODE_ENV !== "test") =>
  pinoHttp({
    logger: log,
    autoLogging,
    customLogLevel: (_req, res, err) => {
      if (res.statusCode >= 500 || err) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    // Raw URL paths and query strings can contain member identifiers or PHI.
    customSuccessMessage: (req, res) => `${req.method} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${res.statusCode}`,
    customProps: (req) => ({
      requestId: (req as unknown as { requestId?: string }).requestId,
    }),
    serializers: {
      req: (req) => ({ method: req.method }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });

export const requestLogger = createRequestLogger();
