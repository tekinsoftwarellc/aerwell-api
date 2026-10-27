// CI guard: code that handles live audio must not write files or objects.
// Run: node --test scripts/check-no-audio-persistence.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

export const GUARDED = ["src/api/visit"];
// path -> reason. Needs a reviewer. Empty on purpose.
export const ALLOW = {};

const RULES = [
  ["fs-import", /from\s+["'](node:)?fs(\/promises)?["']|require\(\s*["'](node:)?fs|import\(\s*["'](node:)?fs/],
  ["fs-call", /\bfs\s*\./],
  ["file-write", /\b(writeFile|appendFile|createWriteStream)\w*/],
  ["s3", /@aws-sdk\/(client-s3|lib-storage)|\bS3Client\b|\bPutObject\w*/],
  ["storage-module", /from\s+["'][^"']*(upload|serviceImage)[^"']*["']/i],
];

function* tsFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "__tests__") yield* tsFiles(path);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) yield path;
  }
}

export function findViolations(root, dirs, allow) {
  const found = [];
  for (const dir of dirs) {
    for (const file of tsFiles(join(root, dir))) {
      const rel = file.slice(root.length + 1);
      if (rel in allow) continue;
      readFileSync(file, "utf8").split("\n").forEach((text, i) => {
        const t = text.trim();
        if (t.startsWith("//") || t.startsWith("*")) return;
        for (const [rule, re] of RULES) if (re.test(t)) found.push({ file: rel, line: i + 1, rule });
      });
    }
  }
  return found;
}

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "audio-guard-"));
  mkdirSync(join(root, "d"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "d", name), body);
  return root;
}
const rulesOf = (files) => findViolations(fixture(files), ["d"], {}).map((v) => v.rule);

test("flags each persistence rule", () => {
  assert.deepEqual(rulesOf({ "a.ts": 'import { writeFileSync } from "node:fs";' }).sort(), ["file-write", "fs-import"]);
  assert.deepEqual(rulesOf({ "a.ts": "const c = new S3Client({});" }), ["s3"]);
  assert.deepEqual(rulesOf({ "a.ts": "new PutObjectCommand({});" }), ["s3"]);
  assert.deepEqual(rulesOf({ "a.ts": "await fs.promises.rm(x);" }), ["fs-call"]);
  assert.deepEqual(rulesOf({ "a.ts": 'import { x } from "../upload/upload.service.js";' }), ["storage-module"]);
});

test("ignores refs.length, comments and test files", () => {
  assert.deepEqual(rulesOf({ "a.ts": "const n = confirmed?.refs.length;" }), []);
  assert.deepEqual(rulesOf({ "a.ts": "// fs.write in a comment\n * writeFile too" }), []);
  assert.deepEqual(rulesOf({ "a.test.ts": 'import { readFileSync } from "node:fs";' }), []);
});

test("guarded dirs exist and contain at least one .ts file", () => {
  for (const dir of GUARDED) assert.ok([...tsFiles(join(process.cwd(), dir))].length > 0, dir);
});

test("the real tree has no violations", () => {
  assert.deepEqual(findViolations(process.cwd(), GUARDED, ALLOW), []);
});
