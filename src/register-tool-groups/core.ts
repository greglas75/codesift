import { CORE_INDEX_TOOL_ENTRIES } from "./core/index.js";
import { CORE_BATCH_SEARCH_TOOL_ENTRIES, CORE_SEARCH_TOOL_ENTRIES } from "./core/search.js";
import { CORE_SYMBOL_TOOL_ENTRIES } from "./core/symbols.js";
import { CORE_META_TOOL_ENTRIES } from "./core/meta.js";
import type { ToolDefinitionEntry } from "./shared.js";

export const CORE_TOOL_ENTRIES: ToolDefinitionEntry[] = [
  ...CORE_INDEX_TOOL_ENTRIES,
  ...CORE_SEARCH_TOOL_ENTRIES,
  ...CORE_SYMBOL_TOOL_ENTRIES,
  ...CORE_META_TOOL_ENTRIES,
  ...CORE_BATCH_SEARCH_TOOL_ENTRIES,
];
