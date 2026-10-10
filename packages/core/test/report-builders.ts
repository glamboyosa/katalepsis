import type { PlaywrightJsonReport } from "../src/index.ts";

type Result = PlaywrightJsonReport["suites"][number]["specs"][number]["tests"][number]["results"][number];
type Test = PlaywrightJsonReport["suites"][number]["specs"][number]["tests"][number];

export const result = (overrides: Partial<Result> = {}): Result => ({
  retry: 0,
  status: "passed",
  duration: 100,
  startTime: "2026-01-01T00:00:00.000Z",
  attachments: [],
  ...overrides,
});

export const test = (overrides: Partial<Test> = {}): Test => ({
  projectName: "chromium",
  expectedStatus: "passed",
  status: "expected",
  annotations: [],
  results: [result()],
  ...overrides,
});

/** Builds a report with one file suite holding one spec per entry. */
export const report = (
  specs: ReadonlyArray<{ title: string; tests: ReadonlyArray<Test> }>,
  errors: PlaywrightJsonReport["errors"] = [],
): PlaywrightJsonReport => ({
  config: { version: "1.63.0" },
  errors,
  suites: [
    {
      title: "checkout.spec.ts",
      specs: specs.map((spec, index) => ({
        title: spec.title,
        file: "checkout.spec.ts",
        line: index + 1,
        tests: spec.tests,
      })),
    },
  ],
});
