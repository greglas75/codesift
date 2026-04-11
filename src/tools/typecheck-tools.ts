/**
 * run_mypy / run_pyright — Python type checker integration.
 *
 * Shells out to mypy or pyright, parses JSON output, and correlates
 * findings with CodeSift's symbol graph for containing_symbol context.
 */
import { execFileSync } from "node:child_process";
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";

export interface TypeCheckFinding {
  tool: "mypy" | "pyright";
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "note";
  rule?: string;         // mypy error code like `arg-type`, pyright rule like `reportMissingImports`
  message: string;
  containing_symbol?: {
    name: string;
    kind: string;
    start_line: number;
  };
}

export interface TypeCheckResult {
  tool: "mypy" | "pyright";
  findings: TypeCheckFinding[];
  total: number;
  by_severity: Record<string, number>;
  tool_available: boolean;
}

/** Cached availability per tool */
const _available: Record<string, boolean | null> = { mypy: null, pyright: null };

export function _resetTypeCheckCache(): void {
  _available.mypy = null;
  _available.pyright = null;
}

function isToolAvailable(tool: "mypy" | "pyright"): boolean {
  if (_available[tool] !== null) return _available[tool]!;
  try {
    execFileSync(tool, ["--version"], { timeout: 5000, stdio: "pipe" });
    _available[tool] = true;
  } catch {
    _available[tool] = false;
  }
  return _available[tool]!;
}

/**
 * Run mypy on the repository.
 */
export async function runMypy(
  repo: string,
  options?: {
    file_pattern?: string;
    strict?: boolean;
    max_results?: number;
  },
): Promise<TypeCheckResult> {
  return runTypeCheck(repo, "mypy", options);
}

/**
 * Run pyright on the repository.
 */
export async function runPyright(
  repo: string,
  options?: {
    file_pattern?: string;
    strict?: boolean;
    max_results?: number;
  },
): Promise<TypeCheckResult> {
  return runTypeCheck(repo, "pyright", options);
}

async function runTypeCheck(
  repo: string,
  tool: "mypy" | "pyright",
  options?: {
    file_pattern?: string;
    strict?: boolean;
    max_results?: number;
  },
): Promise<TypeCheckResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const filePattern = options?.file_pattern;
  const maxResults = options?.max_results ?? 100;
  const strict = options?.strict ?? false;

  if (!isToolAvailable(tool)) {
    return {
      tool,
      findings: [],
      total: 0,
      by_severity: {},
      tool_available: false,
    };
  }

  const target = filePattern ? `${index.root}/${filePattern}` : index.root;

  let raw: string;
  try {
    if (tool === "mypy") {
      const args = ["--show-error-codes", "--no-error-summary", "--no-color-output"];
      if (strict) args.push("--strict");
      args.push(target);
      raw = execFileSync("mypy", args, {
        timeout: 60_000,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
    } else {
      const args = ["--outputjson"];
      if (strict) args.push("--level", "error");
      args.push(target);
      raw = execFileSync("pyright", args, {
        timeout: 60_000,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
    }
  } catch (err: unknown) {
    // Both tools exit with code 1 when errors found — output is in stdout
    if (err && typeof err === "object" && "stdout" in err) {
      raw = (err as { stdout: string }).stdout ?? "";
    } else {
      return { tool, findings: [], total: 0, by_severity: {}, tool_available: true };
    }
  }

  const findings = tool === "mypy"
    ? parseMypyOutput(raw, index.root)
    : parsePyrightOutput(raw, index.root);

  // Correlate with symbols
  const symbolsByFile = new Map<string, CodeSymbol[]>();
  for (const sym of index.symbols) {
    if (!sym.file.endsWith(".py")) continue;
    const existing = symbolsByFile.get(sym.file);
    if (existing) existing.push(sym);
    else symbolsByFile.set(sym.file, [sym]);
  }

  const enriched: TypeCheckFinding[] = [];
  for (const f of findings) {
    if (enriched.length >= maxResults) break;
    if (filePattern && !f.file.includes(filePattern)) continue;

    const fileSyms = symbolsByFile.get(f.file) ?? [];
    const containing = fileSyms.find(
      (s) => s.start_line <= f.line && s.end_line >= f.line,
    );

    const finding: TypeCheckFinding = { ...f, tool };
    if (containing) {
      finding.containing_symbol = {
        name: containing.name,
        kind: containing.kind,
        start_line: containing.start_line,
      };
    }
    enriched.push(finding);
  }

  const by_severity: Record<string, number> = {};
  for (const f of enriched) {
    by_severity[f.severity] = (by_severity[f.severity] ?? 0) + 1;
  }

  return {
    tool,
    findings: enriched,
    total: enriched.length,
    by_severity,
    tool_available: true,
  };
}

/**
 * Parse mypy text output. Format:
 *   path/to/file.py:42: error: message [error-code]
 */
function parseMypyOutput(raw: string, root: string): TypeCheckFinding[] {
  const findings: TypeCheckFinding[] = [];
  const lines = raw.split("\n");
  const re = /^(.+?):(\d+)(?::(\d+))?:\s*(error|warning|note):\s*(.+?)(?:\s*\[([\w-]+)\])?$/;

  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;

    const relPath = m[1]!.startsWith(root) ? m[1]!.slice(root.length + 1) : m[1]!;
    const finding: TypeCheckFinding = {
      tool: "mypy",
      file: relPath,
      line: Number(m[2]),
      col: m[3] ? Number(m[3]) : 0,
      severity: m[4] as "error" | "warning" | "note",
      message: m[5]!,
    };
    if (m[6]) finding.rule = m[6];
    findings.push(finding);
  }

  return findings;
}

/**
 * Parse pyright JSON output (--outputjson).
 * Format: { generalDiagnostics: [{ file, range, severity, message, rule }] }
 */
function parsePyrightOutput(raw: string, root: string): TypeCheckFinding[] {
  let parsed: {
    generalDiagnostics?: Array<{
      file: string;
      range: { start: { line: number; character: number } };
      severity: string;
      message: string;
      rule?: string;
    }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const diagnostics = parsed.generalDiagnostics ?? [];
  return diagnostics.map((d) => {
    const relPath = d.file.startsWith(root) ? d.file.slice(root.length + 1) : d.file;
    const finding: TypeCheckFinding = {
      tool: "pyright",
      file: relPath,
      line: d.range.start.line + 1, // pyright is 0-indexed
      col: d.range.start.character + 1,
      severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "note",
      message: d.message,
    };
    if (d.rule) finding.rule = d.rule;
    return finding;
  });
}
