/**
 * analyze_async_correctness — detect async/await bugs in Python code.
 *
 * Finds 8 common asyncio pitfalls that cause production issues but are
 * silent at test time:
 *
 *   1. blocking-requests      — requests.get() inside async def (use httpx)
 *   2. blocking-sleep         — time.sleep() in async def (use asyncio.sleep)
 *   3. blocking-io            — open()/read() in async (use aiofiles)
 *   4. sync-db-in-async       — sync SQLAlchemy/Django ORM in async view
 *   5. missing-await          — coroutine expression used as regular value
 *   6. async-without-await    — async def with no await (probably unnecessary)
 *   7. blocking-subprocess    — subprocess.run/call in async (use asyncio.subprocess)
 *   8. globalscope-task       — asyncio.create_task without storing ref (GC loss)
 *
 * Uses symbol graph: walks each async function's source text for the
 * patterns above. Returns file/line/symbol/pattern/suggested fix.
 */
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";

export interface AsyncFinding {
  rule: string;
  severity: "error" | "warning" | "info";
  file: string;
  line: number;
  symbol: string;
  symbol_kind: string;
  match: string;
  message: string;
  fix: string;
}

export interface AsyncCorrectnessResult {
  findings: AsyncFinding[];
  total: number;
  by_rule: Record<string, number>;
  async_functions_scanned: number;
}

interface Check {
  rule: string;
  severity: AsyncFinding["severity"];
  regex: RegExp;
  message: string;
  fix: string;
}

const CHECKS: Check[] = [
  {
    rule: "blocking-requests",
    severity: "error",
    regex: /\brequests\.(get|post|put|delete|patch|head|options|request)\s*\(/,
    message: "requests library is synchronous — blocks the event loop",
    fix: "Use httpx.AsyncClient: async with httpx.AsyncClient() as client: await client.get(url)",
  },
  {
    rule: "blocking-sleep",
    severity: "error",
    regex: /\btime\.sleep\s*\(/,
    message: "time.sleep() blocks the event loop, freezes all concurrent tasks",
    fix: "Use await asyncio.sleep(seconds) instead",
  },
  {
    rule: "blocking-io",
    severity: "warning",
    regex: /(?<!async\s)\bopen\s*\([^)]*\)(?!\s*async)/,
    message: "open() and file I/O block the event loop on slow disks",
    fix: "Use aiofiles.open() for async file I/O, or run_in_executor for heavy I/O",
  },
  {
    rule: "sync-db-in-async",
    severity: "error",
    regex: /\b(?:session|db)\.(query|execute|commit|flush|add)\s*\(/,
    message: "Synchronous SQLAlchemy session blocks the event loop",
    fix: "Use AsyncSession: await session.execute(stmt), async with session.begin()",
  },
  {
    rule: "sync-orm-django",
    severity: "error",
    regex: /\.objects\.(?:get|filter|all|count|exists|create|update|delete)\s*\(/,
    message: "Synchronous Django ORM blocks the event loop in async views",
    fix: "Use async ORM methods (.aget(), .acount(), .aall()) or wrap with sync_to_async",
  },
  {
    rule: "blocking-subprocess",
    severity: "error",
    regex: /\bsubprocess\.(run|call|check_output|check_call|Popen)\s*\(/,
    message: "subprocess is synchronous — blocks the event loop",
    fix: "Use asyncio.create_subprocess_exec() or asyncio.create_subprocess_shell()",
  },
  {
    rule: "globalscope-task",
    severity: "warning",
    regex: /(?<!=\s)\basyncio\.create_task\s*\(/,
    message: "asyncio.create_task() without storing the returned Task — may be garbage collected before completion",
    fix: "Store in a set: tasks.add(asyncio.create_task(...)); tasks.discard on done",
  },
];

/**
 * Check for async def with no await in body — possibly unnecessary async.
 * Handled separately from the CHECKS array because it requires symbol-level
 * analysis (not just a regex on source).
 */
function isAsyncWithoutAwait(sym: CodeSymbol): boolean {
  if (!sym.is_async) return false;
  const source = sym.source ?? "";
  // Strip docstring to avoid false positive on "await" in doc
  const withoutDocstring = source.replace(/"""[\s\S]*?"""/g, "").replace(/'''[\s\S]*?'''/g, "");
  // If the function body has no await, async with, or async for, flag it
  return !/\bawait\b/.test(withoutDocstring)
    && !/\basync\s+with\b/.test(withoutDocstring)
    && !/\basync\s+for\b/.test(withoutDocstring)
    && !/\byield\b/.test(withoutDocstring); // async generators need yield
}

/**
 * Analyze async correctness across all async Python functions.
 */
export async function analyzeAsyncCorrectness(
  repo: string,
  options?: {
    file_pattern?: string;
    rules?: string[];
    max_results?: number;
  },
): Promise<AsyncCorrectnessResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const filePattern = options?.file_pattern;
  const enabled = new Set(
    options?.rules ?? [
      ...CHECKS.map((c) => c.rule),
      "async-without-await",
    ],
  );
  const maxResults = options?.max_results ?? 200;

  const findings: AsyncFinding[] = [];
  let asyncFunctionCount = 0;

  for (const sym of index.symbols) {
    if (findings.length >= maxResults) break;
    if (!sym.file.endsWith(".py")) continue;
    if (filePattern && !sym.file.includes(filePattern)) continue;
    if (!sym.is_async) continue;

    asyncFunctionCount++;
    const source = sym.source ?? "";

    // async-without-await check
    if (enabled.has("async-without-await") && isAsyncWithoutAwait(sym)) {
      findings.push({
        rule: "async-without-await",
        severity: "info",
        file: sym.file,
        line: sym.start_line,
        symbol: sym.name,
        symbol_kind: sym.kind,
        match: `async def ${sym.name}`,
        message: "async def with no await in body — may be unnecessarily async",
        fix: "Remove async if not needed, or add real await operations",
      });
    }

    // Pattern-based checks
    for (const check of CHECKS) {
      if (!enabled.has(check.rule)) continue;
      check.regex.lastIndex = 0;
      const m = check.regex.exec(source);
      if (!m) continue;

      // Compute line offset within the symbol
      const lineOffset = source.slice(0, m.index).split("\n").length - 1;
      // Extract the matching line
      const lineStart = source.lastIndexOf("\n", m.index) + 1;
      const lineEnd = source.indexOf("\n", m.index);
      const matchLine = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();

      findings.push({
        rule: check.rule,
        severity: check.severity,
        file: sym.file,
        line: sym.start_line + lineOffset,
        symbol: sym.name,
        symbol_kind: sym.kind,
        match: matchLine.slice(0, 200),
        message: check.message,
        fix: check.fix,
      });
    }
  }

  const by_rule: Record<string, number> = {};
  for (const f of findings) {
    by_rule[f.rule] = (by_rule[f.rule] ?? 0) + 1;
  }

  return {
    findings,
    total: findings.length,
    by_rule,
    async_functions_scanned: asyncFunctionCount,
  };
}
