import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";
import { CODE_EXTENSIONS, DEFAULT_MIN_LINES, denyTool, isCodesiftServerRunning, isCurrentRepoIndexed } from "./shared.js";
import { parseHookInput, readRawInput } from "./input.js";
import { tryLoadWikiSummary } from "./wiki.js";

const DEFAULT_MAX_BYTES = 20_000;
const MAX_READ_HOOK_MAX_BYTES = 1_000_000;

function readHookMaxBytes(): number {
  const raw = process.env["CODESIFT_READ_HOOK_MAX_BYTES"];
  if (!raw) return DEFAULT_MAX_BYTES;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(parsed, MAX_READ_HOOK_MAX_BYTES);
}

export function safeRelPath(filePath: string): string {
  return filePath
    .split(/[/\\]/)
    .slice(-3)
    .join("/")
    // Matching control characters IS the job here: this strips them out of a path before it is
    // echoed back to the user, so a crafted filename cannot inject terminal escapes into hook
    // output. C0 (\u0000-\u001f) and DEL alone are not enough for that claim — C1
    // (\u0080-\u009f) contains CSI at \u009b, which terminals decoding Latin-1 act on exactly
    // like ESC[. The comment used to promise escape-injection safety that the class did not
    // deliver.
    // The explanation sits above the directive because biome-ignore binds only to the line
    // directly after it; putting prose in between silently disables the suppression.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate control-character strip
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

function readRedirectReason(filePath: string, lineCount: number | null, sizeBytes: number | null): string {
  const relPath = safeRelPath(filePath);
  const quotedRelPath = JSON.stringify(relPath);
  const sizeReason = sizeBytes !== null ? ` and ${sizeBytes} bytes` : "";
  const fileStats = lineCount === null ? `is ${sizeBytes} bytes` : `has ${lineCount} lines${sizeReason}`;
  // The bounded read leads, and says outright that it needs no preceding search. When it was
  // listed LAST, after three CodeSift suggestions, it read as the fallback after a search — so an
  // agent that already knew the location still searched first and then read, turning one operation
  // into two. An external benchmark measured reads per trial going UP (4.0 -> 5.0) under this hook,
  // which is the opposite of what redirecting reads is supposed to do.
  return (
    `File ${quotedRelPath} ${fileStats} — too large to read whole.\n` +
    `  Already know where you need to be? Read a bounded range (pass offset+limit) — always allowed, and it needs NO search first.\n` +
    `  Otherwise, use CodeSift tools to locate it:\n` +
    `    search_text(repo, "query", file_pattern=${quotedRelPath}) for specific content\n` +
    `    get_file_outline(repo, ${quotedRelPath}) for structure\n` +
    `    get_symbol(repo, "symbol_id") for a specific function`
  );
}

function unsupportedReadReason(filePath: string): string {
  const quotedRelPath = JSON.stringify(safeRelPath(filePath));
  return `File ${quotedRelPath} is not a regular file. Use CodeSift tools for indexed source files instead of reading special files.`;
}

function inspectFileWithCaps(filePath: string, maxBytes: number, minLines: number): {
  lineCount: number | null;
  bytesRead: number;
  sizeBytes: number;
  unsupported: boolean;
} {
  const pathStat = statSync(filePath);
  if (!pathStat.isFile()) {
    return { lineCount: null, bytesRead: 0, sizeBytes: pathStat.size, unsupported: true };
  }

  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const fileStat = fstatSync(fd);
    if (!fileStat.isFile()) {
      return { lineCount: null, bytesRead: 0, sizeBytes: 0, unsupported: true };
    }
    const sizeBytes = fileStat.size;
    if (sizeBytes > maxBytes) {
      return { lineCount: null, bytesRead: 0, sizeBytes, unsupported: false };
    }

    const buffer = Buffer.alloc(Math.min(8192, maxBytes + 1));
    let bytesReadTotal = 0;
    let lineCount = sizeBytes === 0 ? 0 : 1;

    while (bytesReadTotal <= maxBytes && lineCount < minLines) {
      const bytesToRead = Math.min(buffer.length, maxBytes + 1 - bytesReadTotal);
      if (bytesToRead <= 0) break;
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, null);
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] === 10) lineCount += 1;
      }
    }

    return { lineCount, bytesRead: bytesReadTotal, sizeBytes, unsupported: false };
  } finally {
    closeSync(fd);
  }
}

export async function handlePrecheckRead(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }

    const { filePath, hasBoundedRange } = parseHookInput(raw);
    if (!filePath) {
      process.exit(0);
      return;
    }

    const ext = extname(filePath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) {
      process.exit(0);
      return;
    }

    if (!isCurrentRepoIndexed() || !isCodesiftServerRunning()) {
      process.exit(0);
      return;
    }

    if (hasBoundedRange) {
      process.exit(0);
      return;
    }

    const minLinesEnv = process.env["CODESIFT_READ_HOOK_MIN_LINES"];
    const parsed_min = minLinesEnv ? parseInt(minLinesEnv, 10) : NaN;
    const minLines = Number.isNaN(parsed_min) ? DEFAULT_MIN_LINES : parsed_min;
    const maxBytes = readHookMaxBytes();

    let readResult: { lineCount: number | null; bytesRead: number; sizeBytes: number; unsupported: boolean };
    try {
      readResult = inspectFileWithCaps(filePath, maxBytes, minLines);
    } catch {
      process.exit(0);
      return;
    }

    if (readResult.unsupported) {
      denyTool(unsupportedReadReason(filePath));
      return;
    }

    if (readResult.sizeBytes > maxBytes) {
      denyTool(readRedirectReason(filePath, null, readResult.sizeBytes));
      return;
    }

    const lineCount = readResult.lineCount ?? 1;
    const contentBytes = Math.max(readResult.sizeBytes, readResult.bytesRead);
    if (lineCount >= minLines || contentBytes > maxBytes) {
      denyTool(readRedirectReason(filePath, lineCount, contentBytes));
      return;
    }

    const wikiSummary = tryLoadWikiSummary(filePath);
    if (wikiSummary) {
      process.stdout.write(wikiSummary);
    }
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

/** Wrapper commands that precede the real command word (`sudo rg`, `xargs -0 rg`). */
const COMMAND_PREFIXES = new Set([
  "sudo", "env", "time", "command", "nohup", "nice", "stdbuf", "exec", "builtin", "xargs",
  "if", "elif", "then", "else", "while", "until", "do", "!",
]);

interface ShellToken {
  /** Token text with quoting removed. */
  text: string;
  /** True when any part of the token came from inside quotes. */
  quoted: boolean;
}

/**
 * Lex a command line into segments, each starting at a command position.
 *
 * A regex over the raw string cannot do this correctly, and the two failure
 * modes both showed up in practice:
 *
 *  - Quoted text was treated as shell code, so any command that merely MENTIONS
 *    a search tool got intercepted — `echo "use rg instead"`, or a python/node
 *    analysis script passed via `-c`/heredoc whose source contains `'rg'`.
 *  - Flags were matched across the whole line, so `grep -ic x "$f" | sort -rn`
 *    read as a recursive grep because of `sort`'s `-rn`.
 *
 * Quoted regions therefore stay inert for separator splitting but keep their
 * text (so `"rg" "TODO"` is still recognised as ripgrep). UNQUOTED command
 * substitutions (`$(...)`, backticks) split into their own segment so the inner
 * command is still checked. Heredoc bodies are skipped entirely — they are
 * data, not commands.
 *
 * Known limit: a substitution nested INSIDE double quotes (`echo "$(rg x)"`) is
 * consumed as one quoted token, so the inner command is not inspected. That is
 * an accepted under-block: this hook is a nudge toward CodeSift, not a security
 * boundary, and the costly direction is over-blocking — a false deny stops
 * legitimate work, a missed nudge only means the agent used grep.
 */
function lexShellSegments(cmd: string): ShellToken[][] {
  const segments: ShellToken[][] = [];
  let segment: ShellToken[] = [];
  let text = "";
  let quoted = false;
  let started = false;

  const endToken = (): void => {
    if (!started) return;
    segment.push({ text, quoted });
    text = "";
    quoted = false;
    started = false;
  };
  const endSegment = (): void => {
    endToken();
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };

  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i]!;

    // Herestring (`<<<WORD`) is NOT a heredoc and has no body. Without this the
    // scanner skips the first `<`, then reads the remaining `<<WORD` as a
    // heredoc open, finds no closing `WORD` line, and swallows the REST OF THE
    // COMMAND as body — so `cat <<<EOF; rg "TODO" src/` silently under-blocks.
    if (ch === "<" && cmd[i + 1] === "<" && cmd[i + 2] === "<") {
      endToken();
      i += 3;
      continue;
    }

    // Heredoc (`<<EOF`, `<<-EOF`, `<<'EOF'`) — skip the redirect and its body.
    if (ch === "<" && cmd[i + 1] === "<") {
      const marker = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(cmd.slice(i));
      if (marker) {
        endToken();
        i += marker[0].length;
        const rest = cmd.slice(i);
        const end = new RegExp(`\\n[ \\t]*${marker[2]!}[ \\t]*(?:\\n|$)`).exec(rest);
        i += end ? end.index + end[0].length : rest.length;
        continue;
      }
    }

    if (ch === "'") {
      started = true;
      quoted = true;
      i++;
      while (i < cmd.length && cmd[i] !== "'") { text += cmd[i]; i++; }
      i++;
      continue;
    }

    if (ch === '"') {
      started = true;
      quoted = true;
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === "\\" && i + 1 < cmd.length) { text += cmd[i + 1]; i += 2; continue; }
        text += cmd[i];
        i++;
      }
      i++;
      continue;
    }

    if (ch === "\\" && i + 1 < cmd.length) {
      started = true;
      text += cmd[i + 1];
      i += 2;
      continue;
    }

    if (ch === "\n") { endSegment(); i++; continue; }
    if (/\s/.test(ch)) { endToken(); i++; continue; }
    // Backtick substitution splits like `$(...)` does. Without this the tick
    // glues onto the command word (`` `grep `` != `grep`) and the whole
    // invocation slips past unrecognised.
    if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")" || ch === "{" || ch === "}" || ch === "`") {
      endSegment();
      i++;
      continue;
    }

    started = true;
    text += ch;
    i++;
  }

  endSegment();
  return segments;
}

/** The command a segment actually invokes, plus its unquoted argument tokens. */
function segmentInvocation(tokens: ShellToken[]): { name: string; args: ShellToken[] } | null {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    // Skip `FOO=bar` env assignments and shell/wrapper words like `sudo`, `do`.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text)) { i++; continue; }
    const base = token.text.split("/").pop() ?? token.text;
    if (COMMAND_PREFIXES.has(base)) {
      i++;
      // A wrapper's own flags (`xargs -0 rg`) precede the real command.
      while (i < tokens.length && tokens[i]!.text.startsWith("-")) i++;
      continue;
    }
    return { name: base, args: tokens.slice(i + 1) };
  }
  return null;
}

/** Flags only count when they were written unquoted — `grep "x -r y" f` is a pattern. */
function hasFlag(args: ShellToken[], pattern: RegExp): boolean {
  return args.some((token) => !token.quoted && pattern.test(token.text));
}

function isFileFindCommand(cmd: string): boolean {
  for (const segment of lexShellSegments(cmd)) {
    const invocation = segmentInvocation(segment);
    if (invocation?.name !== "find") continue;
    const hasNameFilter = hasFlag(invocation.args, /^-i?name$/);
    const hasDestructive =
      hasFlag(invocation.args, /^-(?:exec|delete|ok)$/) ||
      invocation.args.some((token) => !token.quoted && (token.text === "rm" || token.text === "mv"));
    if (hasNameFilter && !hasDestructive) return true;
  }
  return false;
}

function isContentGrepCommand(cmd: string): boolean {
  for (const segment of lexShellSegments(cmd)) {
    const invocation = segmentInvocation(segment);
    if (!invocation) continue;
    if (invocation.name === "rg") return true;
    // `git grep` lexes as command `git` with args `grep …`, so it never matches
    // here — which is intended: it is repo-aware already and is left alone.
    if (invocation.name !== "grep" && invocation.name !== "egrep") continue;
    if (hasFlag(invocation.args, /^--recursive$/) || hasFlag(invocation.args, /^-[A-Za-z]*[rR]/)) return true;
  }
  return false;
}

export async function handlePrecheckBash(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }

    const { command } = parseHookInput(raw);
    if (!command) {
      process.exit(0);
      return;
    }

    const shouldIntercept = isFileFindCommand(command) || isContentGrepCommand(command);
    if (!shouldIntercept) {
      process.exit(0);
      return;
    }

    if (!isCurrentRepoIndexed() || !isCodesiftServerRunning()) {
      process.exit(0);
      return;
    }

    if (isFileFindCommand(command)) {
      denyTool(
        `Current repo is indexed by CodeSift. Use CodeSift MCP tools instead of find:\n` +
          `  get_file_tree(compact=true, name_pattern="*.ts")\n` +
          `  search_symbols(query="test", kind="function")`,
      );
    }

    if (isContentGrepCommand(command)) {
      denyTool(
        `Current repo is indexed by CodeSift. Use CodeSift MCP tools instead of grep/rg:\n` +
          `  search_text(query="pattern", file_pattern="*.ts")\n` +
          `  search_symbols(query="name", include_source=true)`,
      );
    }

    process.exit(0);
  } catch {
    process.exit(0);
  }
}

export async function handlePrecheckGlob(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }
    // "CodeSift is available" must be true before we say it. This denied
    // unconditionally, so a dead server left callers with neither Glob nor the
    // tools it advertised.
    if (!isCodesiftServerRunning()) {
      process.exit(0);
      return;
    }
    denyTool(
      `CodeSift is available. Use CodeSift instead of Glob:\n` +
        `  get_file_tree(compact=true, name_pattern="*.ts") — find files\n` +
        `  search_symbols(query="name", kind="function") — find symbols`,
    );
  } catch {
    process.exit(0);
  }
}

export async function handlePrecheckGrep(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }
    // Same as Glob above: never redirect to tools the caller cannot reach.
    if (!isCodesiftServerRunning()) {
      process.exit(0);
      return;
    }
    denyTool(
      `CodeSift is available. Use CodeSift instead of Grep:\n` +
        `  search_text(query="pattern", file_pattern="*.ts") — BM25-ranked full-text search\n` +
        `  search_symbols(query="name", include_source=true) — find functions/classes`,
    );
  } catch {
    process.exit(0);
  }
}
