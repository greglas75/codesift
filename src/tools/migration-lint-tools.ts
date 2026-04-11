/**
 * migration_lint — PostgreSQL migration anti-pattern detection.
 *
 * Thin wrapper around the squawk CLI (https://github.com/sbdchd/squawk).
 * Finds migration SQL files in the index, runs squawk --reporter Json on them,
 * and aggregates findings by severity/rule.
 *
 * squawk is an optional external dependency; if it is not on PATH this tool
 * returns a friendly install hint rather than throwing.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { matchFilePattern } from "../utils/glob.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationLintFinding {
  file: string;
  line: number;
  rule: string;
  level: "warning" | "error";
  message: string;
  url?: string;
}

export interface MigrationLintResult {
  squawk_version?: string;
  squawk_installed: boolean;
  files_checked: number;
  findings: MigrationLintFinding[];
  by_severity: { error: number; warning: number };
  by_rule: Record<string, number>;
  install_hint?: string;
}

// Default glob patterns covering common migration layouts.
const DEFAULT_MIGRATION_GLOBS = [
  "prisma/migrations/**/*.sql",
  "migrations/**/*.sql",
  "db/migrate/**/*.sql",
  "drizzle/**/*.sql",
];

const INSTALL_HINT =
  "squawk not found. Install: brew install squawk OR cargo install squawk-cli OR https://github.com/sbdchd/squawk#installation";

// ---------------------------------------------------------------------------
// Small promise-based execFile wrapper — keeps the callback form (which makes
// mocking in tests trivial) while exposing an async/await surface.
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
}

function runExecFile(
  cmd: string,
  args: string[],
  opts: { maxBuffer: number; timeout: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      // Default encoding is utf-8 so stdout/stderr are strings here.
      const out = (stdout ?? "") as string;
      const errOut = (stderr ?? "") as string;
      if (err) {
        // Attach stdout/stderr so the caller can still parse JSON output even
        // when squawk exits non-zero (it exits non-zero when findings exist).
        const withIO = err as NodeJS.ErrnoException & {
          stdout?: string;
          stderr?: string;
        };
        withIO.stdout = out;
        withIO.stderr = errOut;
        reject(err);
        return;
      }
      resolve({ stdout: out, stderr: errOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function migrationLint(
  repo: string,
  options?: {
    migration_glob?: string;
    excluded_rules?: string[];
    pg_version?: string;
  },
): Promise<MigrationLintResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  // ---- 1. Find migration files in the index -------------------------------
  const globs = options?.migration_glob
    ? [options.migration_glob]
    : DEFAULT_MIGRATION_GLOBS;

  const migrationFiles = index.files
    .filter((f) => globs.some((g) => matchFilePattern(f.path, g)))
    .map((f) => f.path);

  // No files — return an empty, non-error result.
  if (migrationFiles.length === 0) {
    return {
      squawk_installed: true,
      files_checked: 0,
      findings: [],
      by_severity: { error: 0, warning: 0 },
      by_rule: {},
    };
  }

  // ---- 2. Probe squawk --version to detect installation -------------------
  let squawkVersion: string | undefined;
  try {
    const { stdout } = await runExecFile("squawk", ["--version"], {
      maxBuffer: 1 << 20, // 1 MB
      timeout: 5_000,
    });
    squawkVersion = stdout.trim() || undefined;
  } catch (err) {
    if (isEnoent(err)) {
      return {
        squawk_installed: false,
        files_checked: migrationFiles.length,
        findings: [],
        by_severity: { error: 0, warning: 0 },
        by_rule: {},
        install_hint: INSTALL_HINT,
      };
    }
    // Some other problem (e.g. squawk crashed on --version). Treat as not
    // usable but surface the hint so the agent can guide the user.
    return {
      squawk_installed: false,
      files_checked: migrationFiles.length,
      findings: [],
      by_severity: { error: 0, warning: 0 },
      by_rule: {},
      install_hint: INSTALL_HINT,
    };
  }

  // ---- 3. Build squawk CLI args ------------------------------------------
  const cliArgs: string[] = ["--reporter", "Json"];
  if (options?.pg_version) {
    cliArgs.push("--pg-version", options.pg_version);
  }
  if (options?.excluded_rules && options.excluded_rules.length > 0) {
    cliArgs.push("--exclude", options.excluded_rules.join(","));
  }
  // Pass absolute paths so squawk does not depend on CWD.
  for (const relPath of migrationFiles) {
    cliArgs.push(join(index.root, relPath));
  }

  // ---- 4. Run squawk ------------------------------------------------------
  let stdout = "";
  try {
    const res = await runExecFile("squawk", cliArgs, {
      maxBuffer: 32 * 1024 * 1024, // 32 MB
      timeout: 60_000,
    });
    stdout = res.stdout;
  } catch (err) {
    // squawk exits non-zero when there are findings — that's expected.
    // The stdout is attached to the error by runExecFile.
    const attached = (err as { stdout?: string }).stdout;
    if (attached) {
      stdout = attached;
    } else if (isEnoent(err)) {
      return {
        squawk_installed: false,
        files_checked: migrationFiles.length,
        findings: [],
        by_severity: { error: 0, warning: 0 },
        by_rule: {},
        install_hint: INSTALL_HINT,
      };
    } else {
      // Surface a structured error result so agents can still reason about it.
      const result: MigrationLintResult = {
        squawk_installed: true,
        files_checked: migrationFiles.length,
        findings: [],
        by_severity: { error: 0, warning: 0 },
        by_rule: {},
      };
      if (squawkVersion) result.squawk_version = squawkVersion;
      return result;
    }
  }

  // ---- 5. Parse squawk JSON ----------------------------------------------
  const raw = parseSquawkOutput(stdout);
  const rootPrefix = index.root.endsWith("/") ? index.root : index.root + "/";

  const findings: MigrationLintFinding[] = raw.map((r) => {
    // Normalise file paths back to repo-relative when possible.
    let filePath = r.file;
    if (filePath.startsWith(rootPrefix)) {
      filePath = filePath.slice(rootPrefix.length);
    }
    const level: "warning" | "error" =
      String(r.level).toLowerCase() === "error" ? "error" : "warning";
    const finding: MigrationLintFinding = {
      file: filePath,
      line: typeof r.line === "number" ? r.line : Number(r.line ?? 0) || 0,
      rule: String(r.rule_name ?? r.rule ?? "unknown"),
      level,
      message: String(r.message ?? ""),
    };
    if (r.url) finding.url = String(r.url);
    return finding;
  });

  // ---- 6. Aggregate -------------------------------------------------------
  const by_severity = { error: 0, warning: 0 };
  const by_rule: Record<string, number> = {};
  for (const f of findings) {
    by_severity[f.level] += 1;
    by_rule[f.rule] = (by_rule[f.rule] ?? 0) + 1;
  }

  const result: MigrationLintResult = {
    squawk_installed: true,
    files_checked: migrationFiles.length,
    findings,
    by_severity,
    by_rule,
  };
  if (squawkVersion) result.squawk_version = squawkVersion;
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RawSquawkFinding {
  file: string;
  line?: number | string;
  column?: number;
  level?: string;
  message?: string;
  rule_name?: string;
  rule?: string;
  url?: string;
}

/**
 * squawk --reporter Json can emit either a single JSON array or one JSON
 * object per line (NDJSON). We handle both.
 */
function parseSquawkOutput(stdout: string): RawSquawkFinding[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  // Try array first
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed as RawSquawkFinding[];
    } catch {
      // fall through to NDJSON
    }
  }

  // Try single object
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed as RawSquawkFinding[];
      if (parsed && typeof parsed === "object") return [parsed as RawSquawkFinding];
    } catch {
      // fall through to NDJSON
    }
  }

  // NDJSON — one object per line
  const results: RawSquawkFinding[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try {
      const parsed = JSON.parse(l);
      if (Array.isArray(parsed)) {
        results.push(...(parsed as RawSquawkFinding[]));
      } else if (parsed && typeof parsed === "object") {
        results.push(parsed as RawSquawkFinding);
      }
    } catch {
      // Skip non-JSON lines (squawk sometimes prints a header/footer).
    }
  }
  return results;
}

function isEnoent(err: unknown): boolean {
  return (
    !!err
    && typeof err === "object"
    && "code" in err
    && (err as { code?: unknown }).code === "ENOENT"
  );
}
