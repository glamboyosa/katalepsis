import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/*.live.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["packages/*/test/**/*.integration.test.ts"],
          testTimeout: 120_000,
          // The leftover-browser checks count Chromium processes, so files must not overlap.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "live",
          include: ["packages/*/test/**/*.live.test.ts"],
          testTimeout: 320_000,
        },
      },
    ],
  },
});
