import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: {
    // katalepsis sets KATALEPSIS_BASE_URL to the preview URL under test.
    baseURL: process.env.KATALEPSIS_BASE_URL ?? "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
