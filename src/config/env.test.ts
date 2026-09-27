import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { envObject, envSchema } from "./env.js";

const production = {
  NODE_ENV: "production",
  MONGODB_URI: "mongodb://127.0.0.1/test",
  CORS_ORIGIN: "https://admin.example.com",
  STAFF_JWT_SECRET: "x".repeat(32),
  AERWELL_ORG_ID: "org-prod",
};
describe("environment contract", () => {
  it("treats blank keys copied from .env.example as unset", () => {
    const blank = {
      MONGODB_URI: "mongodb://127.0.0.1/test",
      RATE_LIMIT_WINDOW_MS: "",
      RATE_LIMIT_MAX: "",
      ALFRED_API_INTERNAL_URL: "",
      BEDROCK_MODEL_FAST: "",
      AERWELL_ORG_ID: "",
    };
    const parsed = envSchema.parse(blank);
    expect(parsed.RATE_LIMIT_MAX).toBe(100);
    expect(parsed).not.toHaveProperty("ALFRED_API_INTERNAL_URL");
    expect(parsed).not.toHaveProperty("BEDROCK_MODEL_FAST");
    expect(envSchema.safeParse({ ...production, AERWELL_ORG_ID: "" }).success).toBe(false);
  });
  it("requires a Mongo URI", () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.path[0] === "MONGODB_URI")).toBe(true);
  });
  it("uses port 3003 and allows local development", () => {
    expect(envSchema.parse({ MONGODB_URI: "mongodb://127.0.0.1/test" }).PORT).toBe(3003);
  });
  it("preserves a valid optional Alfred internal URL and rejects malformed values", () => {
    const base = { MONGODB_URI: "mongodb://127.0.0.1/test" };
    expect(envSchema.parse(base)).not.toHaveProperty("ALFRED_API_INTERNAL_URL");
    expect(
      envSchema.parse({ ...base, ALFRED_API_INTERNAL_URL: "http://127.0.0.1:3002" })
    ).toMatchObject({ ALFRED_API_INTERNAL_URL: "http://127.0.0.1:3002" });
    expect(envSchema.safeParse({ ...base, ALFRED_API_INTERNAL_URL: "not-a-url" }).success).toBe(
      false
    );
  });
  it("rejects production wildcard CORS including lists", () => {
    for (const origin of ["*", "https://admin.example.com,*"]) {
      expect(envSchema.safeParse({ ...production, CORS_ORIGIN: origin }).success).toBe(false);
    }
    expect(
      envSchema.safeParse({ ...production, CORS_ORIGIN: "https://admin.example.com" }).success
    ).toBe(true);
  });
  it("W11: production refuses to boot without staff sign-in keys (no silent 503 login)", () => {
    for (const key of ["STAFF_JWT_SECRET", "AERWELL_ORG_ID"] as const) {
      const { [key]: _omitted, ...rest } = production;
      const result = envSchema.safeParse(rest);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.map((i) => i.path[0])).toContain(key);
    }
    expect(envSchema.safeParse(production).success).toBe(true);
  });
});

describe("W11: deploy start script", () => {
  const script = readFileSync(new URL("../../scripts/start_server.sh", import.meta.url), "utf8");
  it("strips every environment key before pm2 start, so pm2 cannot bake a stale value", () => {
    const keys = Object.keys(envObject.shape);
    expect(keys.filter((key) => !new RegExp(`-u ${key}\\s`).test(script))).toEqual([]);
  });
  it("syncs indexes before traffic and gives pm2 time to drain live captures", () => {
    expect(script.indexOf("npm run db:sync-indexes")).toBeGreaterThan(0);
    expect(script.indexOf("npm run db:sync-indexes")).toBeLessThan(script.indexOf("pm2 start"));
    expect(script).toMatch(/--kill-timeout=5\d{4}/);
  });
});
