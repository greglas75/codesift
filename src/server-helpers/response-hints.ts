import { getCallCount, getSessionState } from "../storage/session-state.js";
const HIGH_CARDINALITY_THRESHOLD = 50;
const BATCHABLE_TOOLS = new Set(["search_text", "search_symbols", "find_references", "get_symbol"]);
const SEQUENTIAL_HINT_THRESHOLD = 3;
let lastToolName = "";
let consecutiveCount = 0;
let listReposCallCount = 0;

/** Session-level tracking for cross-tool hints */
const fileTreePaths = new Set<string>();
let sessionSearchSymbolsCalled = false;
let sessionGetSymbolCount = 0;
const sessionSearchTextPatterns = new Set<string>(); // H12: track distinct file_patterns in search_text
/** Track sequential calls + session-level state. Exported for testing. */
export function trackSequentialCalls(toolName: string): void {
  if (toolName === lastToolName && BATCHABLE_TOOLS.has(toolName)) {
    consecutiveCount++;
  } else {
    consecutiveCount = 1;
  }
  lastToolName = toolName;

  if (toolName === "list_repos") {
    listReposCallCount++;
  }
  if (toolName === "search_symbols") {
    sessionSearchSymbolsCalled = true;
  }
  if (toolName === "get_symbol") {
    sessionGetSymbolCount++;
  }
  // H12 tracking is in buildResponseHint (needs args, which trackSequentialCalls doesn't receive)
}
const QUESTION_PATTERN = /^(how|where|why|what|when|which)\b/i;
const ROUTE_PATTERN = /\/api\/|endpoint|handler|router\.|middleware|app\.(get|post|put|delete)/i;
const SECRET_PATTERN = /api[._-]?key|AWS_|OPENAI_|SECRET_KEY|password|credential/i;
/**
 * H18: literal substrings that show up in the regex string of Jest/Vitest/RTL
 * test-quality audit patterns. Matches against the raw `query` text the agent
 * passed (treated as a string, not as a parsed regex) — so escapes like `\b`
 * appear as `\\b` here. Detection triggers a "batch via codebase_retrieval"
 * hint to collapse 100+ per-pattern calls into one composite call.
 */
const TEST_ANTIPATTERN_SUBSTRINGS = [
  // Distinctive Jest/Vitest/RTL matcher names — unlikely to appear outside test
  // audit context, so plain substring match is safe.
  "toBeTruthy", "toBeFalsy", "toBeDefined", "toBeGreaterThan", "toBeLessThan",
  "toBeNull", "toBeUndefined",
  "toHaveBeenCalled", "toHaveLength", "toHaveProperty",
  "toMatchSnapshot", "toMatchInlineSnapshot",
  // Common Jest/Vitest regex shapes — note backslash-escaped parens are LITERAL
  // chars in the query string the agent passes (regex=true mode).
  "toBe\\(true", "toBe\\(false", "expect\\(true", "expect\\(false",
  "\\.skip\\(", "\\.only\\(",
  // Use only the regex-escaped form for short tokens like "as any" — the bare
  // 6-char string was false-positive prone (e.g. "has any value", "cargo has anyone").
  "\\bas\\s+any",
  "TODO|FIXME", "FIXME|TODO",
];
function isTestAntipatternQuery(query: string): boolean {
  for (const sig of TEST_ANTIPATTERN_SUBSTRINGS) {
    if (query.includes(sig)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hint codes — compact symbols decoded via CLAUDE.md legend.
// Each hint costs ~3-5 tokens instead of 20-50 tokens in verbose form.
// Legend lives in CLAUDE.md so LLM sees it once per session.
// ---------------------------------------------------------------------------
//
// H1(n)  = >50 matches, add group_by_file=true
// H2(n,t)= consecutive identical tool calls, batch them
// H3(n)  = list_repos called multiple times, result is static
// H4     = include_source without file_pattern, add file_pattern
// H5(p)  = duplicate get_file_tree path, cache result
// H6(n)  = many search_symbols results without detail_level, use compact
// H7     = get_symbol after search_symbols, use get_context_bundle instead
// H8(n)  = 3+ get_symbol calls, use assemble_context(level='L1')
// H9     = question-word text query, use semantic search
// ---------------------------------------------------------------------------

/**
 * Build optimization hints based on response data + call patterns.
 * Returns compact hint codes (decoded in CLAUDE.md).
 */
export function buildResponseHint(toolName: string, args: Record<string, unknown>, data: unknown): string | null {
  const hints: string[] = [];

  if (toolName === "search_text" && Array.isArray(data) && data.length > HIGH_CARDINALITY_THRESHOLD) {
    if (!args["group_by_file"] && !args["auto_group"]) {
      hints.push(`⚡H1(${data.length})`);
    }
  }

  if (consecutiveCount >= SEQUENTIAL_HINT_THRESHOLD && BATCHABLE_TOOLS.has(toolName)) {
    const batchTool = toolName === "get_symbol" ? "get_symbols" : "codebase_retrieval";
    hints.push(`⚡H2(${consecutiveCount},${batchTool})`);
  }

  if (toolName === "list_repos" && listReposCallCount > 1) {
    hints.push(`⚡H3(${listReposCallCount})`);
  }

  if (toolName === "search_symbols" && args["include_source"] && !args["file_pattern"]) {
    hints.push(`⚡H4`);
  }

  if (toolName === "get_file_tree") {
    const repo = typeof args["repo"] === "string" ? args["repo"] : "";
    const pathPrefix = typeof args["path_prefix"] === "string" ? args["path_prefix"] : "";
    const pathKey = `${repo}\0${pathPrefix}`;
    if (fileTreePaths.has(pathKey)) {
      hints.push(`⚡H5(${pathPrefix || "/"})`);
    }
    fileTreePaths.add(pathKey);
  }

  if (toolName === "search_symbols" && !args["detail_level"]) {
    const resultCount = Array.isArray(data) ? data.length : 0;
    if (resultCount > 5) {
      hints.push(`⚡H6(${resultCount})`);
    }
  }

  // H15: search_symbols("<bare keyword>") returned 0 results → query is likely a
  // substring/concept, not a symbol name. Telemetry showed 98× zero-result calls
  // for queries like "auth", "user", "render" — agents kept retrying instead of
  // switching tool. Detect lowercase ≤8-char queries with no uppercase/underscore
  // (true identifiers conventionally include caps or underscores).
  if (toolName === "search_symbols" && Array.isArray(data) && data.length === 0) {
    const q = typeof args["query"] === "string" ? args["query"] : "";
    if (/^[a-z]{2,8}$/.test(q)) {
      hints.push(`⚡H15 "${q}" returned 0 symbols — looks like a keyword, not a symbol name. Try search_text("${q}") for substring matches.`);
    }
  }

  // H11: search_text returned 0 matches → guide next step. Most common causes:
  // file_pattern too narrow, identifier not present as text (only as binding),
  // or concept question that needs semantic search.
  if (toolName === "search_text" && Array.isArray(data) && data.length === 0) {
    const q = typeof args["query"] === "string" ? args["query"] : "";
    const hasFilePattern = Boolean(args["file_pattern"]);
    const isRegex = Boolean(args["regex"]);
    if (q.length > 0) {
      const tips: string[] = [];
      if (hasFilePattern) tips.push(`drop file_pattern`);
      if (!isRegex && /^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(q)) {
        tips.push(`use search_symbols("${q}") for the declaration`);
      }
      if (QUESTION_PATTERN.test(q)) {
        tips.push(`use semantic_search for concept questions`);
      } else if (tips.length === 0) {
        tips.push(`try a broader query or codebase_retrieval(type="semantic")`);
      }
      hints.push(`⚡H11 0 matches for "${q.slice(0, 60)}" — ${tips.join(", or ")}.`);
    }
  }

  // H16: get_file_tree returned an empty list while name_pattern was set →
  // pattern matched nothing. Most common in telemetry: agents trying patterns
  // for extensions the repo doesn't have (e.g. "*.kt" in a JS-only repo).
  if (toolName === "get_file_tree" && typeof args["name_pattern"] === "string" && (args["name_pattern"] as string).length > 0) {
    const isEmpty = Array.isArray(data)
      ? data.length === 0
      : (typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>)["entries"])
          ? ((data as Record<string, unknown>)["entries"] as unknown[]).length === 0
          : false);
    if (isEmpty) {
      hints.push(`⚡H16 0 files match name_pattern="${args["name_pattern"]}". Try omitting name_pattern, or use get_repo_outline to see file structure.`);
    }
  }

  // H17: find_references returned 0 → symbol_name probably misspelled or not a
  // registered symbol. Telemetry showed 94% empty rate for find_references.
  // Agents should verify the symbol exists via search_symbols first.
  if (toolName === "find_references" && Array.isArray(data) && data.length === 0) {
    const name = typeof args["symbol_name"] === "string" ? args["symbol_name"] : "";
    if (name.length > 0) {
      hints.push(`⚡H17 0 references to "${name}" — verify with search_symbols(query="${name}") first; symbol may be misspelled, external, or only referenced in strings/comments (try search_text).`);
    }
  }

  // H18 (Wariant B): search_text with regex matching a known test-antipattern
  // signature → agents are running per-pattern audits one regex at a time.
  // Suggest batching via codebase_retrieval. Catches the bursts of 100+ calls
  // observed in zuvo:test-audit / zuvo:fix-tests sessions.
  if (toolName === "search_text" && args["regex"] && typeof args["query"] === "string") {
    if (isTestAntipatternQuery(args["query"] as string)) {
      hints.push(`⚡H18 query looks like a test-quality pattern — batch multiple via codebase_retrieval(queries=[{type:"text",regex:true,query:"..."}, ...]) to scan once instead of N times.`);
    }
  }

  if (toolName === "get_symbol" && sessionSearchSymbolsCalled) {
    hints.push(`⚡H7`);
  }

  if (toolName === "get_symbol" && sessionGetSymbolCount >= 3) {
    hints.push(`⚡H8(${sessionGetSymbolCount})`);
  }

  if (toolName === "search_text" && typeof args["query"] === "string" && QUESTION_PATTERN.test(args["query"])) {
    hints.push(`⚡H9`);
    // Auto-reveal semantic_search so agents can use it immediately
    import("../register-tools.js").then(m => m.enableToolByName("semantic_search")).catch(() => {});
  }

  // H10: Session snapshot reminder after 50 calls (read-only check; flag set by wrapTool)
  if (getCallCount() >= 50 && !getSessionState().h10Emitted) {
    hints.push(`⚡H10 50+ tool calls this session → call get_session_snapshot to preserve context`);
  }

  // H13: Route-shaped query → suggest trace_route
  if (toolName === "search_text" && typeof args["query"] === "string" && ROUTE_PATTERN.test(args["query"])) {
    hints.push(`⚡H13 route query → try trace_route(path=) for full endpoint tracing`);
  }

  // H14: Secret/credential pattern → suggest scan_secrets
  if (toolName === "search_text" && typeof args["query"] === "string" && SECRET_PATTERN.test(args["query"])) {
    hints.push(`⚡H14 secret pattern → try scan_secrets(min_confidence="high")`);
  }

  // H12: Repeated search_text with different file_patterns → suggest codebase_retrieval batch
  if (toolName === "search_text") {
    const fp = (args["file_pattern"] as string | undefined) ?? "__none__";
    sessionSearchTextPatterns.add(fp);
    if (sessionSearchTextPatterns.size >= SEQUENTIAL_HINT_THRESHOLD) {
      hints.push(`⚡H12(${sessionSearchTextPatterns.size}) ${sessionSearchTextPatterns.size}× search_text with different file_patterns → batch into codebase_retrieval(queries=[...])`);
    }
  }

  return hints.length > 0 ? hints.join(" ") : null;
}

export function resetHintState(): void {
  lastToolName = "";
  consecutiveCount = 0;
  listReposCallCount = 0;
  fileTreePaths.clear();
  sessionSearchSymbolsCalled = false;
  sessionGetSymbolCount = 0;
  sessionSearchTextPatterns.clear();
}
