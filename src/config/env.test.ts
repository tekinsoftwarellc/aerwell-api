import { describe, expect, it } from "vitest";
import { envSchema } from "./env.js";

describe("environment contract", () => {
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
      expect(
        envSchema.safeParse({
          NODE_ENV: "production",
          MONGODB_URI: "mongodb://127.0.0.1/test",
          CORS_ORIGIN: origin,
        }).success
      ).toBe(false);
    }
    expect(
      envSchema.safeParse({
        NODE_ENV: "production",
        MONGODB_URI: "mongodb://127.0.0.1/test",
        CORS_ORIGIN: "https://admin.example.com",
      }).success
    ).toBe(true);
  });
});
