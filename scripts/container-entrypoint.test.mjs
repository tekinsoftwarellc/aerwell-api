import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const entrypoint = path.join(path.dirname(fileURLToPath(import.meta.url)), "container-entrypoint.sh");

// SYNC_CMD replaces `node /app/dist/scripts/sync-indexes.js` so the test needs no database
// (honoured only outside NODE_ENV=production).
function run(extraEnv, command = 'echo "pid $$"; exit 7') {
  return spawnSync("sh", [entrypoint, "sh", "-c", command], {
    // Bare container env: nothing inherited from the developer's shell.
    env: { PATH: process.env.PATH, NODE_ENV: "test", ...extraEnv },
    encoding: "utf8",
  });
}

test("runs the index sync, then execs the command so signals reach the app", () => {
  const r = run({ SYNC_CMD: "true" });
  assert.equal(r.status, 7, r.stderr);
  assert.match(r.stdout, /^index sync: using override$/m);
  // Same pid as the spawned process only if the entrypoint exec'd (replaced the shell).
  assert.equal(r.stdout.split("\n").filter(Boolean).at(-1), `pid ${r.pid}`);
});

test("a failed index sync exits non-zero before the command runs", () => {
  const r = run({ SYNC_CMD: "false" });
  assert.notEqual(r.status, 0);
  assert.notEqual(r.status, 7);
  assert.doesNotMatch(r.stdout, /pid/);
});

test("SKIP_INDEX_SYNC=1 skips the sync", () => {
  const r = run({ SYNC_CMD: "false", SKIP_INDEX_SYNC: "1" });
  assert.equal(r.status, 7, r.stderr);
  assert.equal(r.stdout.trim(), `pid ${r.pid}`);
});
