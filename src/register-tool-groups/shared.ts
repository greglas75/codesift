import { z } from "zod";
import { STUB_LANGUAGES } from "../parser/stub-languages.js";
import { getCodeIndex } from "../register-tool-loaders.js";
import type { AuditScanResult } from "../tools/audit-tools.js";

export { z };

/** Boolean that also accepts "true"/"false" strings (LLMs often send strings instead of booleans) */
export const zBool = () => z.union([z.boolean(), z.string().transform((s) => s === "true")]).optional();

export const zFiniteNumber = z.number().finite();

/** Coerce string->number for numeric params while rejecting NaN/empty strings. */
export const zNum = () =>
  z.union([
    zFiniteNumber,
    z.string()
      .trim()
      .min(1, "Expected a number")
      .transform((value) => Number(value))
      .pipe(zFiniteNumber),
  ]).optional();

type ToolSchemaShape = Record<string, z.ZodTypeAny>;

export function lazySchema(factory: () => ToolSchemaShape): ToolSchemaShape {
  let cached: ToolSchemaShape | undefined;
  const resolve = (): ToolSchemaShape => {
    cached ??= factory();
    return cached;
  };

  return new Proxy({} as ToolSchemaShape, {
    get(_target, prop) {
      return resolve()[prop as keyof ToolSchemaShape];
    },
    has(_target, prop) {
      return prop in resolve();
    },
    ownKeys() {
      return Reflect.ownKeys(resolve());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Object.getOwnPropertyDescriptor(resolve(), prop);
      if (descriptor) return descriptor;
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: resolve()[prop as keyof ToolSchemaShape],
      };
    },
  });
}

export type ToolCategory =
  | "indexing"
  | "search"
  | "outline"
  | "symbols"
  | "graph"
  | "lsp"
  | "architecture"
  | "context"
  | "diff"
  | "analysis"
  | "patterns"
  | "conversations"
  | "security"
  | "reporting"
  | "cross-repo"
  | "nestjs"
  | "navigation"
  | "session"
  | "meta"
  | "discovery";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  /** Category for tool discovery grouping */
  category?: ToolCategory;
  /** Keywords for discover_tools search — helps LLM find the right tool */
  searchHint?: string;
  /** Output schema for structured validation and documentation (optional) */
  outputSchema?: z.ZodTypeAny;
  /**
   * Language gate: this tool is only enabled when the project contains
   * files of the given language. E.g. "python" disables the tool when
   * no .py files exist. Checked at server startup against process.cwd().
   */
  requiresLanguage?: "python" | "php" | "kotlin";
  /**
   * Opt-in response memoization. When true the bind site wraps the handler in
   * an index+git-version-aware LRU cache (see registerToolDefinition): identical
   * calls against the same repo are served without re-running the handler, and
   * the served response carries a `⚡ cached` marker.
   *
   * The cache key folds in the repo's on-disk index version AND its git-dir state
   * (HEAD / index / reflog mtimes), both recomputed fresh on every call (statSync
   * only, no subprocess), so an index change, commit, or branch switch invalidates
   * the entry IMMEDIATELY — there is no TTL / staleness window.
   *
   * Degraded contract: if the repo's index version cannot be observed (repo not in
   * the registry, registry or index file unreadable) the call is NOT cached at all
   * — the handler runs every time. An entry keyed without a version component could
   * never be invalidated, so "unknown version" means "do not memoize", never "cache
   * forever".
   *
   * Only set on deterministic, expensive-to-recompute analysis tools.
   */
  cacheable?: boolean;
  /**
   * Per-tool client-facing timeout budget in milliseconds. Overrides the
   * universal default (env CODESIFT_TOOL_TIMEOUT_MS, else 90s). Ignored for
   * the timeout-exempt long-op allowlist (index_folder/index_file/…).
   */
  timeoutMs?: number;
}

export interface ToolDefinitionEntry {
  order: number;
  definition: ToolDefinition;
}

export const OutputSchemas = {
  /** search_symbols, cross_repo_search */
  searchResults: z.string().describe("Formatted search results: file:line kind name signature"),

  /** get_file_tree */
  fileTree: z.string().describe("File tree with symbol counts per file"),

  /** get_file_outline */
  fileOutline: z.string().describe("Symbol outline: line:end_line kind name"),

  /** get_symbol */
  symbol: z.string().nullable().describe("Symbol source code or null if not found"),

  /** find_references */
  references: z.string().describe("References in file:line: context format"),

  /** trace_call_chain */
  callTree: z.string().describe("Call tree hierarchy or Mermaid diagram"),

  /** impact_analysis */
  impactAnalysis: z.string().describe("Changed files and affected symbols with risk levels"),

  /** codebase_retrieval */
  batchResults: z.string().describe("Concatenated sub-query result sections"),

  /** discover_tools */
  toolDiscovery: z.object({
    query: z.string(),
    matches: z.array(z.object({
      name: z.string(),
      category: z.string(),
      description: z.string(),
      is_core: z.boolean(),
    })),
    total_tools: z.number(),
    categories: z.array(z.string()),
  }),

  /** get_call_hierarchy */
  callHierarchy: z.string().describe("Call hierarchy: symbol with incoming and outgoing calls"),

  /** analyze_complexity */
  complexity: z.string().describe("Complexity report: CC nest lines file:line name"),

  /** find_dead_code */
  deadCode: z.string().describe("Unused exported symbols list"),

  /** find_clones */
  clones: z.string().describe("Code clone pairs with similarity scores"),

  /** scan_secrets */
  secrets: z.string().describe("Secret findings with severity, type, and masked values"),

  /** go_to_definition */
  definition: z.string().nullable().describe("file:line (via lsp|index) with preview"),

  /** get_type_info */
  typeInfo: z.union([
    z.object({ type: z.string(), documentation: z.string().optional(), via: z.literal("lsp") }),
    z.object({ via: z.literal("unavailable"), hint: z.string() }),
  ]),

  /** rename_symbol */
  renameResult: z.object({
    files_changed: z.number(),
    edits: z.array(z.object({ file: z.string(), changes: z.number() })),
  }),

  /** usage_stats */
  usageStats: z.object({ report: z.string() }).passthrough(),

  /** list_repos */
  repoList: z.union([z.array(z.string()), z.array(z.object({ name: z.string() }).passthrough())]),
} as const;

export const SYMBOL_TOOLS = new Set([
  "search_symbols", "get_file_outline", "get_symbol", "get_symbols",
  "find_references", "trace_call_chain", "find_dead_code", "analyze_complexity",
]);

/**
 * Build an H11 hint string from a list of FileEntry-like records. Returns
 * null when no hint is needed. Separated from `checkTextStubHint` so the
 * purely-deterministic core can be unit-tested without spinning up a real
 * index.
 *
 * A file is counted as a "stub" when its language appears in STUB_LANGUAGES
 * (queried dynamically). Languages like `kotlin` that have a real extractor
 * are automatically excluded because they live outside STUB_LANGUAGES, so
 * H11 no longer fires for Kotlin-heavy repos.
 */
export function buildH11Hint(
  files: ReadonlyArray<{ path: string; language: string }>,
): string | null {
  if (files.length === 0) return null;

  const stubFiles = files.filter((f) => STUB_LANGUAGES.has(f.language));
  if (stubFiles.length === 0) return null;

  const stubPct = Math.round((stubFiles.length / files.length) * 100);
  if (stubPct < 30) return null;

  const stubExts = [...new Set(
    stubFiles.map((f) => "." + f.path.split(".").pop())
  )].slice(0, 3).join(", ");

  return `⚡H11 No parser for ${stubExts} files (${stubPct}% of repo). Symbol tools return empty.\n` +
    `  → search_text(query) works on ALL files (uses ripgrep, not parser)\n` +
    `  → get_file_tree shows file listing\n` +
    `  → Only symbol-based tools (this one) need a parser to return results.\n`;
}

/**
 * Check if a repo has stub-language files as a dominant portion. Returns a
 * hint string to prepend to empty results, or null if no hint needed.
 */
export async function checkTextStubHint(repo: string | undefined, toolName: string, resultEmpty: boolean): Promise<string | null> {
  if (!resultEmpty || !repo || !SYMBOL_TOOLS.has(toolName)) return null;

  const index = await getCodeIndex(repo);
  if (!index) return null;

  return buildH11Hint(index.files);
}

export function formatAuditScan(result: AuditScanResult): string {
  const lines: string[] = [];
  lines.push(`AUDIT SCAN: ${result.repo}`);
  lines.push(`Gates checked: ${result.summary.gates_checked} | Findings: ${result.summary.total_findings} (${result.summary.critical} critical, ${result.summary.warning} warning)`);
  lines.push("");

  for (const gate of result.gates) {
    const count = gate.findings.length;
    const status = count === 0 ? "✓ PASS" : `✗ ${count} finding${count > 1 ? "s" : ""}`;
    lines.push(`${gate.gate} ${status} — ${gate.description}`);
    lines.push(`  tool: ${gate.tool_used}`);

    for (const f of gate.findings.slice(0, 10)) {
      const loc = f.line ? `:${f.line}` : "";
      const sev = f.severity === "critical" ? "🔴" : "🟡";
      lines.push(`  ${sev} ${f.file}${loc} — ${f.detail}`);
    }
    if (gate.findings.length > 10) {
      lines.push(`  ... +${gate.findings.length - 10} more`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

interface RegisterToolRuntime {
  detectAutoLoadToolsCached: (cwd: string) => Promise<string[]>;
  enableToolByName: (name: string) => boolean;
}

let registerToolRuntime: RegisterToolRuntime | undefined;

export function setRegisterToolRuntime(runtime: RegisterToolRuntime): void {
  registerToolRuntime = runtime;
}

function getRegisterToolRuntime(): RegisterToolRuntime {
  if (!registerToolRuntime) {
    throw new Error("register tool runtime is not initialized");
  }
  return registerToolRuntime;
}

export function detectAutoLoadToolsCached(cwd: string): Promise<string[]> {
  return getRegisterToolRuntime().detectAutoLoadToolsCached(cwd);
}

export function enableToolByName(name: string): boolean {
  return getRegisterToolRuntime().enableToolByName(name);
}
