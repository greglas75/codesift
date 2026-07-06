import { CORE_TOOL_ENTRIES } from "./core.js";
import { REACT_TOOL_ENTRIES } from "./react.js";
import { ANALYSIS_TOOL_ENTRIES } from "./analysis.js";
import { KOTLIN_TOOL_ENTRIES } from "./kotlin.js";
import { PYTHON_TOOL_ENTRIES } from "./python.js";
import { PHP_TOOL_ENTRIES } from "./php.js";
import { META_TOOL_ENTRIES } from "./meta.js";
import { SQL_TOOL_ENTRIES } from "./sql.js";
import { ASTRO_TOOL_ENTRIES } from "./astro.js";
import { HONO_TOOL_ENTRIES } from "./hono.js";
import { NEXTJS_TOOL_ENTRIES } from "./nextjs.js";
import type { ToolDefinition, ToolDefinitionEntry } from "./shared.js";

const TOOL_ENTRIES: ToolDefinitionEntry[] = [
  ...CORE_TOOL_ENTRIES,
  ...REACT_TOOL_ENTRIES,
  ...ANALYSIS_TOOL_ENTRIES,
  ...KOTLIN_TOOL_ENTRIES,
  ...PYTHON_TOOL_ENTRIES,
  ...PHP_TOOL_ENTRIES,
  ...META_TOOL_ENTRIES,
  ...SQL_TOOL_ENTRIES,
  ...ASTRO_TOOL_ENTRIES,
  ...HONO_TOOL_ENTRIES,
  ...NEXTJS_TOOL_ENTRIES,
];

export const TOOL_DEFINITIONS: ToolDefinition[] = [...TOOL_ENTRIES]
  .sort((a, b) => a.order - b.order)
  .map((entry) => entry.definition);
