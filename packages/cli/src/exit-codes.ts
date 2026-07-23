/**
 * tenfour CLI — uniform exit codes (CLI-MCP §0 CLI-001) and doctor codes (DOC-121).
 */

export const EXIT = {
  /** Success. */
  OK: 0,
  /** Broker rejected the operation; a TENFOUR/<CODE> line was printed. */
  BROKER_REJECTED: 1,
  /** Local error (config missing/invalid, journal, git, filesystem). */
  LOCAL_ERROR: 2,
  /** User aborted at an interactive confirmation. */
  USER_ABORTED: 3,
  /** Usage error (unknown flag/arg) — EX_USAGE. */
  USAGE: 64,
} as const;

/** Doctor-specific exit codes (DOC-121). */
export const DOCTOR_EXIT = {
  ALL_PASS: 0,
  WARNINGS: 4,
  FAILURES: 1,
  CANNOT_RUN: 2,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
