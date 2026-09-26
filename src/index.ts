import { startNotificationJobs } from "./api/notification/producers.js";
import { logger } from "./common/utils/logger.js";
import { connectDB, disconnectDB } from "./config/database.js";
import { env } from "./config/env.js";
import { createServer } from "./server.js";

await connectDB();
const server = createServer().listen(env.PORT, env.HOST, () => {
  logger.info({ port: env.PORT }, "Aerwell API listening");
});
const jobs = env.AERWELL_ORG_ID ? startNotificationJobs(env.AERWELL_ORG_ID) : undefined;
server.on("error", () => {
  logger.error("HTTP server failed");
  process.exit(1);
});
let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(jobs);
  const timeout = setTimeout(() => process.exit(1), 10_000).unref();
  server.close(async () => {
    await disconnectDB();
    clearTimeout(timeout);
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
