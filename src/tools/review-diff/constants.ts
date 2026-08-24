export const ALL_CHECKS = [
  "secrets",
  "breaking",
  "coupling",
  "complexity",
  "dead-code",
  "blast-radius",
  "bug-patterns",
  "test-gaps",
  "hotspots",
  "astro-hydration",
] as const;

export type CheckName = (typeof ALL_CHECKS)[number];

export const DEFAULT_MAX_FILES = 50;
export const DEFAULT_CHECK_TIMEOUT_MS = 30_000;

/**
 * Ceiling for everything BEFORE the checks: resolving the git range, filtering changed files and
 * computing changed symbols.
 *
 * 45s leaves room for one full round of checks (30s, parallel) inside the 90s client-facing tool
 * timeout. Without it the phase had no ceiling, so a large enough range could run past the tool
 * timeout — which answers `timed_out` and lets the work continue, rather than stopping it.
 */
export const DEFAULT_PREPARE_TIMEOUT_MS = 45_000;
export const HEAD_TILDE_PATTERN = /^HEAD~\d+$/;
