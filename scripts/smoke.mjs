import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { MongoMemoryServer } from "mongodb-memory-server";

const isolatedCwd = await mkdtemp(join(tmpdir(), "aerwell-api-smoke-"));
const entrypoint = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const missingMongo = spawnSync(process.execPath, [entrypoint], {
  cwd: isolatedCwd, env: { NODE_ENV: "production" }, encoding: "utf8",
});
assert.notEqual(missingMongo.status, 0);
assert.match(missingMongo.stderr, /Invalid environment keys: MONGODB_URI/);
console.log("Missing MONGODB_URI fails before the server starts.");
const mongo = await MongoMemoryServer.create();
const reservation = net.createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const { port } = reservation.address();
await new Promise((resolve) => reservation.close(resolve));
const child = spawn(process.execPath, [entrypoint], {
  cwd: isolatedCwd,
  env: {
    PATH: process.env.PATH,
    NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
    MONGODB_URI: mongo.getUri("aerwell-smoke"), CORS_ORIGIN: "https://admin.example.com",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
const exited = once(child, "exit");
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(500) }); } catch { /* startup */ }
    if (response?.ok) break;
    if (child.exitCode !== null) throw new Error("Compiled server exited before health check");
    await delay(100);
  }
  assert.equal(response?.status, 200);
  const curl = spawnSync("curl", ["--silent", "--show-error", "--fail", `http://127.0.0.1:${port}/api/v1/health`], { encoding: "utf8" });
  assert.equal(curl.status, 0);
  const body = JSON.parse(curl.stdout);
  assert.equal(body.success, true);
  assert.equal(body.data.database.status, "connected");
  assert.equal(body.data.database.name, "aerwell-smoke");
  console.log(`node dist/index.js + memory Mongo: curl health HTTP 200 ${JSON.stringify(body)}`);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api-docs/`)).status, 404);
  child.kill("SIGTERM");
  const [exitCode] = await Promise.race([exited, delay(12_000, undefined, { ref: false }).then(() => { throw new Error("Shutdown timed out"); })]);
  assert.equal(exitCode, 0);
  console.log("Production docs hidden; graceful SIGTERM exit 0.");
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await mongo.stop();
  await rm(isolatedCwd, { recursive: true, force: true });
  if (child.exitCode && logs) console.error(logs);
}
