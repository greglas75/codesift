import type { BuiltinPatternDefinition } from "./types.js";
import { REACT_PATTERNS_BEFORE_NEXTJS, REACT_PATTERNS_AFTER_NEXTJS } from "./adapters/react.js";
import { COMMON_PATTERNS } from "./adapters/common.js";
import { KOTLIN_PATTERNS } from "./adapters/kotlin.js";
import { PHP_PATTERNS } from "./adapters/php.js";
import { NEST_PATTERNS } from "./adapters/nest.js";
import { ASTRO_PATTERNS } from "./adapters/astro.js";
import { NEXTJS_EARLY_PATTERNS, NEXTJS_PATTERNS } from "./adapters/nextjs.js";
import { HONO_PATTERNS } from "./adapters/hono.js";
import { DATABASE_PATTERNS } from "./adapters/database.js";
import { PYTHON_PATTERNS } from "./adapters/python.js";

/**
 * Stable built-in pattern catalog.
 *
 * Spread order is part of the existing listPatterns contract.
 */
export const BUILTIN_PATTERNS: Record<string, BuiltinPatternDefinition> = {
  ...REACT_PATTERNS_BEFORE_NEXTJS,
  ...NEXTJS_EARLY_PATTERNS,
  ...REACT_PATTERNS_AFTER_NEXTJS,
  ...COMMON_PATTERNS,
  ...KOTLIN_PATTERNS,
  ...PHP_PATTERNS,
  ...NEST_PATTERNS,
  ...ASTRO_PATTERNS,
  ...NEXTJS_PATTERNS,
  ...HONO_PATTERNS,
  ...DATABASE_PATTERNS,
  ...PYTHON_PATTERNS,
};
