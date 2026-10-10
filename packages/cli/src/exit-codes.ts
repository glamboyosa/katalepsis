import type { CheckStatus } from "@katalepsis/core";

export const EXIT = {
  passed: 0,
  failed: 1,
  blocked: 2,
  /** Bad arguments or a project that cannot be verified. No report was written. */
  usage: 3,
  /** Verification ran but the report bundle could not be written. */
  reportWrite: 4,
} as const;

export const exitCodeFor = (status: CheckStatus): number => EXIT[status];
