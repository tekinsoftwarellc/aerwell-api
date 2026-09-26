import { createRequire } from "node:module";
import pino, { type DestinationStream } from "pino";
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

// Keep log messages constant. Structured sensitive values are redacted at the root
// and common nested locations; whole request bodies and data payloads are removed.
const sensitiveFields = [
  "authorization",
  "cookie",
  "password",
  "secret",
  "client_secret",
  "clientSecret",
  "accessToken",
  "refreshToken",
  "access_token",
  "refresh_token",
  "token",
  "email",
  "name",
  "firstName",
  "lastName",
  "fullName",
  "phone",
  "phoneNumber",
  "dateOfBirth",
  "dob",
  "notes",
  "note",
  "noteBody",
  "body",
  "clinicalNotes",
  "labValue",
  "labValues",
  "labResults",
  "value",
  "data",
];
const redactPaths = sensitiveFields.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]);

export const createLogger = (destination?: DestinationStream): pino.Logger => {
  const options: pino.LoggerOptions = {
    level: isDevelopment ? "debug" : "info",
    transport: destination ? undefined : resolveTransport(),
    redact: { paths: redactPaths, censor: "[REDACTED]" },
    // Error messages/stacks may embed URLs, credentials or validation inputs.
    serializers: {
      error: (error: Error) => ({ type: error.name }),
      err: (error: Error) => ({ type: error.name }),
    },
    base: { pid: false },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(options, destination) : pino(options);
};

export const logger = createLogger();
export type Logger = typeof logger;
