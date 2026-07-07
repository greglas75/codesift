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
export const HEAD_TILDE_PATTERN = /^HEAD~\d+$/;
