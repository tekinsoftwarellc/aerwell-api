import { startNotificationJobs } from "./api/notification/producers.js";
import { attachVisitSockets } from "./api/visit/visit.socket.js";
import { logger } from "./common/utils/logger.js";
import { connectDB, disconnectDB } from "./config/database.js";
import { env } from "./config/env.js";
import { createServer } from "./server.js";

await connectDB();
const server = createServer().listen(env.PORT, env.HOST, () => {
  logger.info({ port: env.PORT }, "Aerwell API listening");
});
const jobs = env.AERWELL_ORG_ID ? startNotificationJobs(env.AERWELL_ORG_ID) : undefined;
// W9: authenticated WebSocket for live visit transcription (same HTTP server).
const closeVisitSockets = attachVisitSockets(server);
server.on("error", () => {
  logger.error("HTTP server failed");
  process.exit(1);
});
let shuttingDown = false;
// pm2 must allow this long (start_server.sh passes --kill-timeout) or live captures lose their tail.
const SHUTDOWN_MS = 45_000;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(jobs);
  const timeout = setTimeout(() => process.exit(1), SHUTDOWN_MS).unref();
  // Stop taking connections, then flush live captures while Mongo is still connected.
  server.close(async () => {
    await disconnectDB();
    clearTimeout(timeout);
    process.exit(0);
  });
  // Longer than a capture's own 30 s provider-finish timeout.
  await closeVisitSockets(SHUTDOWN_MS - 10_000);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
