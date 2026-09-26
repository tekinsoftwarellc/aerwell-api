import { createRequire } from "node:module";
import pino from "pino";
import { env } from "../../config/env.js";

const isDevelopment = env.NODE_ENV === "development";
const require = createRequire(import.meta.url);

const resolveTransport = (): pino.TransportSingleOptions | undefined => {
  if (!isDevelopment) {
    return undefined;
  }

  try {
    require.resolve("pino-pretty");
    return {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    };
  } catch {
    console.warn(
      "pino-pretty is not installed; falling back to standard JSON logs. Set NODE_ENV=production on EC2."
    );
    return undefined;
  }
};

export const logger = pino({
  level: isDevelopment ? "debug" : "info",
  transport: resolveTransport(),
  // pino only serializes Errors under the `err` key by default, and message/stack are
  // non-enumerable — so the many `logger.error({ error }, "...")` sites across the codebase
  // logged an empty object. Serializing both keys makes every one of them useful.
  serializers: {
    error: pino.stdSerializers.err,
    err: pino.stdSerializers.err,
  },
  base: {
    pid: false,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
