/**
 * `codesift dup-check` — the duplicated-code gate for pre-push hooks and review skills.
 *
 * Exit codes are the contract hooks rely on: 0 clean (or not indexed without --strict), 1 duplicates
 * found, 2 the check could not run (not a git checkout, unknown base, bad flag, or not indexed with
 * --strict).
 */
import type { Flags } from "./args.js";
import { getBoolFlag, getFlag } from "./args.js";
import type { DupCheckResult, DupSymbolRef } from "../tools/dup-check-tools.js";

export interface DupCheckCommandOutput {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

const HINT =
  "Reuse or extend the existing code; if the copy is intentional, add `// codesift-dup-ok: <reason>` above it.";

function loc(sym: DupSymbolRef): string {
  return `${sym.file}:${sym.start_line} ${sym.name}`;
}

export function formatDupCheck(result: DupCheckResult): string {
  const lines: string[] = [];
  for (const f of result.findings) {
    lines.push(
      `NEW ${loc(f.new)} ≈ EXISTING ${loc(f.existing)} (similarity ${f.similarity.toFixed(2)}, ${f.shared_lines} shared lines)`,
    );
  }
  for (const a of result.allowed) {
    lines.push(`ALLOWED ${loc(a.new)} ≈ ${loc(a.existing)} (similarity ${a.similarity.toFixed(2)}) — ${a.reason}`);
  }
  const summary =
    `codesift dup-check: ${result.checked_symbols} changed symbol(s) in ${result.changed_files} file(s) ` +
    `vs ${result.repo ?? "?"} (base ${result.base}): ${result.findings.length} duplicate(s)`;
  lines.push(summary);
  if (result.findings.length > 0) lines.push(HINT);
  return lines.join("\n") + "\n";
}

function numberFlag(flags: Flags, name: string, check: (n: number) => boolean): number | undefined | string {
  const raw = getFlag(flags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && check(n) ? n : `invalid --${name}: ${raw}`;
}

export async function runDupCheckCommand(flags: Flags, cwd: string): Promise<DupCheckCommandOutput> {
  const threshold = numberFlag(flags, "threshold", (n) => n > 0 && n <= 1);
  const minLines = numberFlag(flags, "min-lines", (n) => Number.isInteger(n) && n >= 1);
  for (const v of [threshold, minLines]) {
    if (typeof v === "string") return { exitCode: 2, stdout: "", stderr: `codesift dup-check: ${v}\n` };
  }
  const strict = getBoolFlag(flags, "strict") === true;
  const json = getBoolFlag(flags, "json") === true;

  const { runDupCheck, DupCheckUsageError } = await import("../tools/dup-check-tools.js");
  let result: DupCheckResult;
  try {
    result = await runDupCheck({
      cwd,
      base: getFlag(flags, "base"),
      repo: getFlag(flags, "repo"),
      threshold: threshold as number | undefined,
      minLines: minLines as number | undefined,
    });
  } catch (err: unknown) {
    if (err instanceof DupCheckUsageError) {
      return { exitCode: 2, stdout: "", stderr: `codesift dup-check: ${err.message}\n` };
    }
    throw err;
  }

  if (result.status === "not_indexed") {
    const stderr =
      `codesift dup-check: warning: this checkout is not indexed — run \`codesift index <root>\`` +
      `${strict ? "" : " (skipping the check)"}\n`;
    return { exitCode: strict ? 2 : 0, stdout: json ? JSON.stringify(result, null, 2) + "\n" : "", stderr };
  }
  const stdout = json ? JSON.stringify(result, null, 2) + "\n" : formatDupCheck(result);
  return { exitCode: result.findings.length > 0 ? 1 : 0, stdout, stderr: "" };
}

export async function handleDupCheck(_args: string[], flags: Flags): Promise<void> {
  const out = await runDupCheckCommand(flags, process.cwd());
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}
