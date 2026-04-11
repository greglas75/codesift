/**
 * Ruff linting integration — shell out to `ruff check`, parse JSON output,
 * and correlate findings with CodeSift's symbol graph.
 */
import { execFileSync } from "node:child_process";
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";

export interface RuffFinding {
  rule: string;           // e.g. "B006", "PERF401"
  message: string;
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning";
  containing_symbol?: {
    name: string;
    kind: string;
    start_line: number;
  };
}

export interface RuffResult {
  findings: RuffFinding[];
  total: number;
  by_rule: Record<string, number>;
  ruff_available: boolean;
}

/** Default rule categories worth exposing via MCP */
const DEFAULT_CATEGORIES = ["B", "PERF", "SIM", "UP", "S", "ASYNC", "RET", "ARG"];

/**
 * Run ruff on the repository and return structured findings.
 * Correlates each finding with the containing CodeSift symbol.
 */
export async function runRuff(
  repo: string,
  options?: {
    categories?: string[];
    file_pattern?: string;
    max_results?: number;
  },
): Promise<RuffResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const categories = options?.categories ?? DEFAULT_CATEGORIES;
  const filePattern = options?.file_pattern;
  const maxResults = options?.max_results ?? 100;

  // Check if ruff is available
  let ruffAvailable = true;
  try {
    execFileSync("ruff", ["version"], { timeout: 5000, stdio: "pipe" });
  } catch {
    ruffAvailable = false;
    return {
      findings: [],
      total: 0,
      by_rule: {},
      ruff_available: false,
    };
  }

  // Build ruff command
  const selectArg = categories.join(",");
  const target = filePattern
    ? `${index.root}/${filePattern}`
    : index.root;

  let output: string;
  try {
    output = execFileSync(
      "ruff",
      ["check", "--output-format", "json", "--select", selectArg, target],
      { timeout: 30_000, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (err: unknown) {
    // ruff exits with code 1 when findings exist — output is in stdout
    if (err && typeof err === "object" && "stdout" in err) {
      output = (err as { stdout: string }).stdout ?? "[]";
    } else {
      return { findings: [], total: 0, by_rule: {}, ruff_available: true };
    }
  }

  // Parse JSON output
  let rawFindings: Array<{
    code: string;
    message: string;
    filename: string;
    location: { row: number; column: number };
  }>;
  try {
    rawFindings = JSON.parse(output);
  } catch {
    return { findings: [], total: 0, by_rule: {}, ruff_available: true };
  }

  // Build Python symbols by file for fast lookup
  const symbolsByFile = new Map<string, CodeSymbol[]>();
  for (const sym of index.symbols) {
    if (!sym.file.endsWith(".py")) continue;
    const existing = symbolsByFile.get(sym.file);
    if (existing) existing.push(sym);
    else symbolsByFile.set(sym.file, [sym]);
  }

  const findings: RuffFinding[] = [];
  const by_rule: Record<string, number> = {};

  for (const raw of rawFindings) {
    if (findings.length >= maxResults) break;

    // Convert absolute path to relative
    const relPath = raw.filename.startsWith(index.root)
      ? raw.filename.slice(index.root.length + 1)
      : raw.filename;

    if (filePattern && !relPath.includes(filePattern)) continue;

    // Find containing symbol
    const fileSyms = symbolsByFile.get(relPath) ?? [];
    const containing = fileSyms.find(
      (s) => s.start_line <= raw.location.row && s.end_line >= raw.location.row,
    );

    findings.push({
      rule: raw.code,
      message: raw.message,
      file: relPath,
      line: raw.location.row,
      col: raw.location.column,
      severity: raw.code.startsWith("S") ? "error" : "warning",
      containing_symbol: containing
        ? { name: containing.name, kind: containing.kind, start_line: containing.start_line }
        : undefined,
    });

    by_rule[raw.code] = (by_rule[raw.code] ?? 0) + 1;
  }

  return {
    findings,
    total: findings.length,
    by_rule,
    ruff_available: ruffAvailable,
  };
}
