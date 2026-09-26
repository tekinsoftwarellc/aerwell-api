import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: {
      concurrent: false,
    },
    fileParallelism: false,
    coverage: {
      provider: "v8",
      thresholds: { "src/api/**/*.ts": { lines: 80 } },
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/test/**",
        "src/**/*.test.ts",
        "src/config/swagger.ts",
        "src/scripts/**",
      ],
    },
  },
});
