/**
 * Stable public facade for pattern execution and built-in pattern access.
 * Implementation lives under ./patterns/ to keep lazy tool imports intact.
 */
export { BUILTIN_PATTERNS, type BuiltinPatternDefinition } from "./pattern-registry.js";
export { searchPatterns, listPatterns } from "./patterns/execution.js";
export type { PatternMatch, PatternResult } from "./patterns/execution.js";
