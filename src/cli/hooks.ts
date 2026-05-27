// ---------------------------------------------------------------------------
// CLI hooks — Cross-platform PreToolUse / PostToolUse hook handlers
// ---------------------------------------------------------------------------
// Supports Claude Code, Codex, Gemini CLI, and Cline.
//
// Input sources:
//   Claude Code / Codex: HOOK_TOOL_INPUT env var (JSON)
//   Gemini CLI / Cline:  stdin (JSON), triggered by --stdin flag
//
// Exit codes: 0 = allow, 2 = deny (with redirect message on stdout)
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, posix as pathPosix } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Cross-platform input parsing
// ---------------------------------------------------------------------------

/**
 * Read raw hook input from env var (Claude/Codex) or stdin (Gemini/Cline).
 */
function readRawInput(): string | null {
  const envInput = process.env["HOOK_TOOL_INPUT"];
  if (envInput) return envInput;

  if (process.argv.includes("--stdin")) {
    try {
      return readFileSync(0, "utf-8");
    } catch {
      return null;
    }
  }

  return null;
}

interface HookInput {
  filePath: string | null;
  sessionId: string | null;
  command: string | null;
  toolName: string | null;
}

const EMPTY_INPUT: HookInput = Object.freeze({ filePath: null, sessionId: null, command: null, toolName: null });

/**
 * Parse hook input JSON once, extracting all fields across all platforms.
 *
 * Supported formats:
 *   Claude Code / Codex: { tool_input: { file_path, command }, session_id }
 *   Gemini CLI:          { tool: { input: { path|file_path, command } }, sessionId }
 *   Cline:               { preToolUse|postToolUse: { args: { file_path } } }
 */
function parseHookInput(raw: string): HookInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_INPUT;
  }
  if (parsed === null || typeof parsed !== "object") return EMPTY_INPUT;
  const obj = parsed as Record<string, unknown>;

  let filePath: string | null = null;
  let command: string | null = null;

  // Claude Code / Codex: { tool_input: { file_path, command } }
  if (obj["tool_input"] && typeof obj["tool_input"] === "object") {
    const ti = obj["tool_input"] as Record<string, unknown>;
    if (typeof ti["file_path"] === "string") filePath = ti["file_path"];
    if (typeof ti["command"] === "string") command = ti["command"];
  }

  // Gemini CLI: { tool: { input: { path|file_path, command } } }
  if (obj["tool"] && typeof obj["tool"] === "object") {
    const tool = obj["tool"] as Record<string, unknown>;
    if (tool["input"] && typeof tool["input"] === "object") {
      const input = tool["input"] as Record<string, unknown>;
      if (filePath === null) {
        if (typeof input["path"] === "string") filePath = input["path"];
        else if (typeof input["file_path"] === "string") filePath = input["file_path"];
      }
      if (command === null && typeof input["command"] === "string") command = input["command"];
    }
  }

  // Cline: { preToolUse|postToolUse: { args: { file_path } } }
  if (filePath === null) {
    for (const key of ["preToolUse", "postToolUse"]) {
      if (obj[key] && typeof obj[key] === "object") {
        const hook = obj[key] as Record<string, unknown>;
        if (hook["args"] && typeof hook["args"] === "object") {
          const args = hook["args"] as Record<string, unknown>;
          if (typeof args["file_path"] === "string") {
            filePath = args["file_path"];
            break;
          }
        }
      }
    }
  }

  // Session ID: top-level { session_id } or { sessionId }
  let sessionId: string | null = null;
  if (typeof obj["session_id"] === "string") sessionId = obj["session_id"];
  else if (typeof obj["sessionId"] === "string") sessionId = obj["sessionId"];

  // Tool name: top-level { tool_name } (Claude Code) or { tool: { name } } (Gemini)
  let toolName: string | null = null;
  if (typeof obj["tool_name"] === "string") toolName = obj["tool_name"];
  else if (obj["tool"] && typeof obj["tool"] === "object") {
    const t = obj["tool"] as Record<string, unknown>;
    if (typeof t["name"] === "string") toolName = t["name"];
  }

  return { filePath, sessionId, command, toolName };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".vue",
  ".svelte",
]);

const DEFAULT_MIN_LINES = 50;

const WIKI_MANIFEST_REL = join(".codesift", "wiki", "wiki-manifest.json");
const WIKI_SUMMARY_DEFAULT_MAX_CHARS = 2500;
const WIKI_OVERVIEW_DEFAULT_MAX_CHARS = 1800;

/** Char budget for `.summary.md` hook injection. `CODESIFT_WIKI_SUMMARY_MAX_CHARS`
 *  env var overrides when it parses to a positive integer; NaN or <=0 falls
 *  back to the default (CQ8: defensive env parsing so the hook never crashes). */
export function wikiSummaryMaxChars(): number {
  return positiveIntEnv("CODESIFT_WIKI_SUMMARY_MAX_CHARS", WIKI_SUMMARY_DEFAULT_MAX_CHARS);
}

/** Char budget for the SessionStart project-overview injection. */
export function wikiOverviewMaxChars(): number {
  return positiveIntEnv("CODESIFT_WIKI_OVERVIEW_MAX_CHARS", WIKI_OVERVIEW_DEFAULT_MAX_CHARS);
}

/** Parse a positive-int env var with a default fallback (NaN/<=0 → default). */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Walk up from `startDir` looking for `.codesift/wiki/wiki-manifest.json`.
 * Returns the repo root directory if found, otherwise null.
 */
function findRepoRootFromDir(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    try {
      readFileSync(join(dir, WIKI_MANIFEST_REL));
      return dir;
    } catch {
      // manifest not found at this level
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Walk up from `filePath`'s directory looking for the wiki manifest.
 * Returns the repo root directory if found, otherwise null.
 */
function findRepoRoot(filePath: string): string | null {
  return findRepoRootFromDir(dirname(filePath));
}

/**
 * Try to load the wiki community summary for `filePath`.
 * Returns the summary string (truncated to WIKI_SUMMARY_MAX_CHARS) if found,
 * or null if any step fails (missing manifest, file not mapped, missing .md, etc.).
 *
 * ALL reads are synchronous — the hook must exit fast.
 * ALL errors are caught — never crash the hook (CQ8).
 */
function tryLoadWikiSummary(filePath: string): string | null {
  try {
    const repoRoot = findRepoRoot(filePath);
    if (!repoRoot) return null;

    const manifestPath = join(repoRoot, WIKI_MANIFEST_REL);
    let manifestRaw: string;
    try {
      manifestRaw = readFileSync(manifestPath, "utf-8");
    } catch {
      return null;
    }

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    } catch {
      return null;
    }

    const fileToComm = manifest["file_to_community"];
    if (!fileToComm || typeof fileToComm !== "object") return null;
    const map = fileToComm as Record<string, unknown>;

    // Resolve the file path relative to the repo root for lookup.
    // Manifest keys are POSIX-style; normalize separators and collapse `./`, `//`
    // so that Windows backslashes and mixed slashes resolve to a single canonical key.
    const relPath = pathPosix.normalize(relative(repoRoot, filePath).split("\\").join("/"));
    const communitySlug = map[relPath];
    if (typeof communitySlug !== "string") return null;

    // Validate slug format (defense-in-depth: prevent path traversal via crafted manifest)
    if (!/^[a-z0-9-]+$/.test(communitySlug)) return null;

    const summaryPath = join(repoRoot, ".codesift", "wiki", `${communitySlug}.summary.md`);
    let summary: string;
    try {
      summary = readFileSync(summaryPath, "utf-8");
    } catch {
      return null;
    }

    const maxChars = wikiSummaryMaxChars();
    return summary.length > maxChars ? summary.slice(0, maxChars) : summary;
  } catch {
    // CQ8: never crash the hook
    return null;
  }
}

/** Current git HEAD short SHA for `dir`, or null on any failure. */
function currentGitCommit(dir: string): string | null {
  try {
    const r = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    const sha = r.stdout.trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Build a compact, agent-facing project overview from the v2 wiki manifest at
 * `repoRoot`. Returns null for missing/v1/malformed manifests (graceful — the
 * caller falls back to the static prompt). Output is capped to the overview
 * char budget so it never bloats the SessionStart context.
 *
 * ALL reads are synchronous and ALL errors are swallowed (CQ8: never crash).
 */
function tryLoadProjectOverview(repoRoot: string): string | null {
  try {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(join(repoRoot, WIKI_MANIFEST_REL), "utf-8")) as Record<string, unknown>;
    } catch {
      return null;
    }
    // v2 manifests carry schema_version === 2; v1 has no project/modules blocks.
    if (manifest["schema_version"] !== 2) return null;

    const project = manifest["project"];
    if (!project || typeof project !== "object") return null;
    const p = project as Record<string, unknown>;
    const stack = (p["stack"] ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

    const lines: string[] = [];
    lines.push(`\n\nCodeSift project wiki (architecture map — use instead of re-discovering structure):`);

    const name = str(p["name"]) ?? "this repo";
    const stackBits = [
      str(stack["language"]),
      str(stack["framework"]),
      str(stack["test_runner"]) ? `test:${str(stack["test_runner"])}` : null,
      str(stack["package_manager"]) ? `pm:${str(stack["package_manager"])}` : null,
    ].filter(Boolean);
    lines.push(`Project: ${name}${stackBits.length ? ` — ${stackBits.join(" · ")}` : ""}`);

    const entry = p["entry_points"];
    if (Array.isArray(entry) && entry.length > 0) {
      lines.push(`Entry points: ${entry.filter((e) => typeof e === "string").slice(0, 5).join(", ")}`);
    }

    const modules = manifest["modules"];
    if (Array.isArray(modules) && modules.length > 0) {
      lines.push(`Modules (${modules.length}):`);
      for (const m of modules.slice(0, 14)) {
        if (!m || typeof m !== "object") continue;
        const mod = m as Record<string, unknown>;
        const mName = str(mod["name"]) ?? str(mod["slug"]) ?? "module";
        let desc = str(mod["description"]) ?? "";
        if (desc.length > 110) desc = desc.slice(0, 107) + "…";
        lines.push(`  - ${mName}${desc ? `: ${desc}` : ""}`);
      }
    }

    const gotchas = p["known_gotchas"];
    if (Array.isArray(gotchas) && gotchas.length > 0) {
      const top = gotchas
        .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
        .sort((a, b) => sevRank(b["severity"]) - sevRank(a["severity"]))
        .slice(0, 2)
        .map((g) => str(g["gotcha"]))
        .filter(Boolean);
      if (top.length > 0) lines.push(`Gotchas: ${top.join(" | ")}`);
    }

    // Staleness hint: compare manifest commit to current HEAD. Best-effort.
    const manifestCommit = str(manifest["git_commit"]);
    const head = currentGitCommit(repoRoot);
    if (manifestCommit && manifestCommit !== "unknown" && head && !head.startsWith(manifestCommit) && !manifestCommit.startsWith(head)) {
      lines.push(`(Wiki generated at ${manifestCommit.slice(0, 8)}; HEAD is ${head.slice(0, 8)} — auto-refreshes on edits.)`);
    }

    const out = lines.join("\n");
    const max = wikiOverviewMaxChars();
    return out.length > max ? out.slice(0, max) : out;
  } catch {
    return null;
  }
}

function sevRank(s: unknown): number {
  return s === "high" ? 3 : s === "medium" ? 2 : s === "low" ? 1 : 0;
}

// ---------------------------------------------------------------------------
// handlePrecheckRead
//
// PreToolUse hook for the Read tool. When the agent attempts to read a large
// code file, deny the read and redirect to CodeSift tools instead.
//
// Env vars:
//   HOOK_TOOL_INPUT               — JSON string with tool_input.file_path
//   CODESIFT_READ_HOOK_MIN_LINES  — override the line threshold (default: 200)
// ---------------------------------------------------------------------------

export async function handlePrecheckRead(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }

    const { filePath } = parseHookInput(raw);
    if (!filePath) {
      process.exit(0);
      return;
    }

    const ext = extname(filePath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) {
      process.exit(0);
      return;
    }

    const minLinesEnv = process.env["CODESIFT_READ_HOOK_MIN_LINES"];
    const parsed_min = minLinesEnv ? parseInt(minLinesEnv, 10) : NaN;
    const minLines = Number.isNaN(parsed_min) ? DEFAULT_MIN_LINES : parsed_min;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      // File not found or unreadable — allow
      process.exit(0);
      return;
    }

    const lineCount = content.split("\n").length;
    if (lineCount >= minLines) {
      const relPath = filePath.split("/").slice(-3).join("/");
      const reason =
        `File ${relPath} has ${lineCount} lines. Use CodeSift tools instead:\n` +
        `  get_file_outline(repo, "${relPath}") for structure\n` +
        `  search_text(repo, "query", file_pattern="${relPath}") for specific content\n` +
        `  get_symbol(repo, "symbol_id") for a specific function`;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }));
      process.exit(0);
      return;
    }

    // Wiki context injection — only fires for small files (not redirected above)
    const wikiSummary = tryLoadWikiSummary(filePath);
    if (wikiSummary) {
      process.stdout.write(wikiSummary);
    }
    process.exit(0);
  } catch {
    // CQ8: never crash — always fall back to allow so the agent is not blocked
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handlePrecheckBash
//
// PreToolUse hook for the Bash tool. When the agent attempts to run file-
// finding (find ... -name) or content-searching (grep -r, rg) commands,
// deny and redirect to CodeSift tools instead.
//
// This ensures sub-agents (Explore, Plan, etc.) use the CodeSift index
// rather than raw shell commands, even when they don't have CodeSift rules
// in their context.
//
// Env vars:
//   HOOK_TOOL_INPUT  — JSON string with tool_input.command
// ---------------------------------------------------------------------------

function isFileFindCommand(cmd: string): boolean {
  const hasFind = /\bfind\s/.test(cmd);
  const hasNameFilter = /\s-i?name\s/.test(cmd);
  // Don't intercept destructive operations
  const hasDestructive = /\s-(?:exec|delete|ok)\b|\brm\s|\bmv\s/.test(cmd);
  return hasFind && hasNameFilter && !hasDestructive;
}

function isContentGrepCommand(cmd: string): boolean {
  // grep -r/-R/--recursive (but not git grep)
  const hasRecursiveGrep =
    /\bgrep\b.*(?:\s-\w*[rR]\w*\s|--recursive)/.test(cmd) && !/\bgit\s+grep\b/.test(cmd);
  // standalone rg (not as part of another word like "org")
  const hasRg = /(?:^|[\s;&|])rg\s/.test(cmd);
  return hasRecursiveGrep || hasRg;
}

function getRegistryPath(): string {
  return join(process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift"), "registry.json");
}

/**
 * Treat the current shell as "inside an indexed repo" when CWD equals OR is
 * a descendant of any registered repo root whose on-disk index still exists.
 * Subdirectory match matters because agents typically work several levels
 * below the repo root (e.g. `src/utils/`); the previous exact-equality check
 * silently bypassed the redirect in those cases.
 */
function isCurrentRepoIndexed(): boolean {
  try {
    const raw = readFileSync(getRegistryPath(), "utf-8");
    const parsed = JSON.parse(raw) as { repos?: unknown };
    if (!parsed.repos || typeof parsed.repos !== "object") return false;

    const repos = Object.values(parsed.repos as Record<string, unknown>);
    const cwd = process.cwd();

    for (const repo of repos) {
      if (!repo || typeof repo !== "object") continue;
      const meta = repo as { root?: unknown; index_path?: unknown };
      if (typeof meta.root !== "string" || typeof meta.index_path !== "string") continue;
      if (!isCwdInsideRepo(cwd, meta.root)) continue;
      if (existsSync(meta.index_path)) return true;
    }
  } catch {
    // Hooks should never block normal shell use if registry inspection fails.
  }
  return false;
}

function isCwdInsideRepo(cwd: string, repoRoot: string): boolean {
  if (cwd === repoRoot) return true;
  const rootWithSep = repoRoot.endsWith("/") ? repoRoot : repoRoot + "/";
  return cwd.startsWith(rootWithSep);
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

    const shouldRedirectToCodeSift = isCurrentRepoIndexed();
    if (!shouldRedirectToCodeSift) {
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
    // CQ8: never crash — always fall back to allow
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handlePrecheckGlob
//
// PreToolUse hook for the Glob tool. Redirects file-finding operations to
// CodeSift's get_file_tree which uses the pre-built index.
//
// Env vars:
//   HOOK_TOOL_INPUT  — JSON string with tool_input.pattern
// ---------------------------------------------------------------------------

export async function handlePrecheckGlob(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) { process.exit(0); return; }
    denyTool(
      `CodeSift is available. Use CodeSift instead of Glob:\n` +
        `  get_file_tree(compact=true, name_pattern="*.ts") — find files\n` +
        `  search_symbols(query="name", kind="function") — find symbols`,
    );
  } catch {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handlePrecheckGrep
//
// PreToolUse hook for the Grep tool. Redirects content-searching operations
// to CodeSift's search_text which uses the pre-built BM25 index.
//
// Env vars:
//   HOOK_TOOL_INPUT  — JSON string with tool_input.pattern
// ---------------------------------------------------------------------------

export async function handlePrecheckGrep(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) { process.exit(0); return; }
    denyTool(
      `CodeSift is available. Use CodeSift instead of Grep:\n` +
        `  search_text(query="pattern", file_pattern="*.ts") — BM25-ranked full-text search\n` +
        `  search_symbols(query="name", include_source=true) — find functions/classes`,
    );
  } catch {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handlePostindexFile
//
// PostToolUse hook for Write/Edit tools. When the agent writes or edits a
// code file, re-index that file so the CodeSift index stays up to date.
//
// Env vars:
//   HOOK_TOOL_INPUT  — JSON string with tool_input.file_path
//
// Always exits 0 (fire-and-forget — never block the agent on hook errors).
// ---------------------------------------------------------------------------

// Debounce window for handlePostindexFile. Telemetry showed 417/659
// index_file calls were duplicates within 60s — Edit/Edit/Edit bursts hit the
// hook 2-3× per logical change. 2s catches them without delaying real reindex.
const POSTINDEX_DEBOUNCE_MS = 2000;

function postindexDebouncePath(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, "hook-debounce.json");
}

/**
 * Returns true if `filePath` was indexed within the debounce window.
 * Best-effort: any I/O error returns false so the hook never blocks the agent.
 */
function shouldDebouncePostindex(filePath: string, now: number): boolean {
  try {
    const path = postindexDebouncePath();
    let state: Record<string, number> = {};
    if (existsSync(path)) {
      try {
        state = JSON.parse(readFileSync(path, "utf-8")) as Record<string, number>;
      } catch {
        state = {};
      }
    }
    const last = state[filePath];
    if (typeof last === "number" && now - last < POSTINDEX_DEBOUNCE_MS) {
      return true;
    }
    // Update state with current timestamp; opportunistically prune stale entries
    // older than 60s to keep the file small.
    const pruned: Record<string, number> = { [filePath]: now };
    for (const [k, v] of Object.entries(state)) {
      if (k !== filePath && typeof v === "number" && now - v < 60_000) {
        pruned[k] = v;
      }
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(pruned));
    } catch {
      // Disk error — fall through; we still indexed once, no harm done.
    }
    return false;
  } catch {
    return false;
  }
}

// Auto-regenerate the wiki at most once per this window per repo. Wiki
// generation is a heavy whole-repo analysis, so it runs detached in the
// background and is throttled well above the per-file reindex debounce. The
// project overview changes slowly, so 30 min keeps CPU cost negligible.
const WIKI_REGEN_DEBOUNCE_MS = 30 * 60 * 1000;

// Skip background auto-regen entirely for repos larger than this (file count).
// Whole-repo analysis on a huge repo is too heavy to run opportunistically on
// edit — users regenerate those manually with `codesift wiki-generate`.
// Override with CODESIFT_WIKI_AUTO_REGEN_MAX_FILES.
const WIKI_REGEN_DEFAULT_MAX_FILES = 5000;
function wikiRegenMaxFiles(): number {
  return positiveIntEnv("CODESIFT_WIKI_AUTO_REGEN_MAX_FILES", WIKI_REGEN_DEFAULT_MAX_FILES);
}

function wikiRegenStatePath(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, "wiki-regen-debounce.json");
}

/** True if `repoRoot`'s wiki was regenerated within the throttle window. */
function shouldDebounceWikiRegen(repoRoot: string, now: number): boolean {
  try {
    const path = wikiRegenStatePath();
    let state: Record<string, number> = {};
    if (existsSync(path)) {
      try { state = JSON.parse(readFileSync(path, "utf-8")) as Record<string, number>; } catch { state = {}; }
    }
    const last = state[repoRoot];
    if (typeof last === "number" && now - last < WIKI_REGEN_DEBOUNCE_MS) return true;
    const pruned: Record<string, number> = { [repoRoot]: now };
    for (const [k, v] of Object.entries(state)) {
      if (k !== repoRoot && typeof v === "number" && now - v < 60 * 60_000) pruned[k] = v;
    }
    try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(pruned)); } catch { /* disk */ }
    return false;
  } catch {
    return false;
  }
}

/**
 * Opportunistically regenerate the wiki for the repo containing `filePath`.
 * Fire-and-forget: spawns a detached `wiki-generate` process and returns
 * immediately so the agent is never blocked. No-ops unless ALL of:
 *   - a wiki already exists for the repo (we never auto-create — opt-in only),
 *   - the repo is not larger than the size cap (huge repos are manual-only),
 *   - the edit added a NEW file (structure changed). Edits to files already
 *     known to the wiki don't change the module map / overview, so they skip
 *     regen — this makes the common case (editing existing code) cost nothing,
 *   - the per-repo throttle window has elapsed.
 * Opt out entirely via `CODESIFT_WIKI_AUTO_REGEN=0`.
 */
function maybeRegenerateWiki(filePath: string, now: number): void {
  try {
    const optOut = process.env.CODESIFT_WIKI_AUTO_REGEN;
    if (optOut === "0" || optOut === "false") return;

    // Only repos that already have a wiki manifest are auto-refreshed.
    const repoRoot = findRepoRoot(filePath);
    if (!repoRoot) return;

    // Read the manifest once for the size + structural gates.
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(join(repoRoot, WIKI_MANIFEST_REL), "utf-8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const fileMap = manifest["file_to_community"];
    const knownFiles = fileMap && typeof fileMap === "object" ? (fileMap as Record<string, unknown>) : null;

    // Size gate: don't run whole-repo analysis in the background for huge repos.
    if (knownFiles && Object.keys(knownFiles).length > wikiRegenMaxFiles()) return;

    // Structural gate: only regenerate when a NEW file appeared. An edit to a
    // file the wiki already knows about doesn't change the architecture map, so
    // we skip it — the throttle is then never even consulted for plain edits.
    if (knownFiles) {
      const rel = pathPosix.normalize(relative(repoRoot, filePath).split("\\").join("/"));
      if (rel in knownFiles) return;
    }

    if (shouldDebounceWikiRegen(repoRoot, now)) return;

    // Re-run the same CLI entry point that's executing this hook, with cwd set
    // to the repo root so `wiki-generate` auto-resolves the repo. Detached +
    // unref + ignored stdio so it outlives this short-lived hook process.
    const cliEntry = process.argv[1];
    if (!cliEntry) return;
    const child = spawn(process.execPath, [cliEntry, "wiki-generate", "--no-lens"], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => { /* CQ8: never surface spawn failures */ });
    child.unref();
  } catch {
    // CQ8: auto-regen is best-effort — never crash the hook.
  }
}

export async function handlePostindexFile(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }

    const { filePath } = parseHookInput(raw);
    if (!filePath) {
      process.exit(0);
      return;
    }

    const ext = extname(filePath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) {
      process.exit(0);
      return;
    }

    if (shouldDebouncePostindex(filePath, Date.now())) {
      process.exit(0);
      return;
    }

    try {
      const { indexFile } = await import("../tools/index-tools.js");
      await indexFile(filePath);
    } catch {
      // CQ8: fire-and-forget — never crash, never block the agent
    }

    // Keep the wiki fresh: throttled, detached background regeneration.
    maybeRegenerateWiki(filePath, Date.now());

    process.exit(0);
  } catch {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handlePrecompactSnapshot
//
// PreCompact hook for Claude Code. Reads the sidecar JSON file written by
// the MCP server process, formats a compact snapshot, and writes it to stdout.
// Claude Code injects stdout content into context before compaction.
//
// Env vars:
//   HOOK_TOOL_INPUT  — JSON string with session_id
//
// Always exits 0 — never blocks compaction.
// ---------------------------------------------------------------------------

export async function handlePrecompactSnapshot(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }

    const { sessionId } = parseHookInput(raw);

    if (!sessionId || !/^[a-f0-9-]+$/i.test(sessionId)) {
      process.exit(0);
      return;
    }

    // Read sidecar file
    const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
    const sidecarPath = join(dataDir, `session-${sessionId}.json`);

    let sidecarData: Record<string, unknown>;
    try {
      const content = readFileSync(sidecarPath, "utf-8");
      sidecarData = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Sidecar missing or invalid — exit gracefully
      process.exit(0);
      return;
    }

    // Deserialize and format snapshot
    const { deserializeState, formatSnapshot } = await import("../storage/session-state.js");
    const sessionState = deserializeState(sidecarData);
    const snapshot = formatSnapshot(sessionState);

    if (snapshot) {
      process.stdout.write(snapshot, () => process.exit(0));
      return;
    }

    process.exit(0);
  } catch {
    // CQ8: never crash — never block compaction
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// SessionStart / SessionGate / SentinelWriter / Agent gate hooks
// Inspired by cmm-claude-code-setup (https://github.com/halindrome/cmm-claude-code-setup)
// ---------------------------------------------------------------------------

/** Emit modern Claude Code "deny" decision via stdout JSON, then exit 0. */
function denyTool(reason: string): never {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function getSessionSentinelPath(sessionId: string | null): string {
  const id = sessionId ?? "default";
  const hash = createHash("sha1").update(id).digest("hex").slice(0, 16);
  return join(tmpdir(), `codesift-session-ready-${hash}`);
}

export async function handleSessionStart(): Promise<void> {
  try {
    const raw = readRawInput();
    const { sessionId } = raw ? parseHookInput(raw) : EMPTY_INPUT;
    const sentinel = getSessionSentinelPath(sessionId);
    try { unlinkSync(sentinel); } catch { /* not exist */ }

    // Inject context prompt
    let additionalContext =
      "CodeSift MCP is available (mcp__codesift__* tools). " +
      "Before searching code with built-in Grep/Glob/Read, prefer CodeSift tools: " +
      "search_text, get_file_tree, search_symbols, plan_turn. " +
      "Repo auto-resolves from CWD — no need for list_repos.";

    // Append the project wiki overview (architecture map) so every session starts
    // oriented without spending tool calls re-discovering structure. Best-effort:
    // only fires when a v2 wiki manifest exists at/above CWD; never blocks startup.
    if (process.env.CODESIFT_WIKI_OVERVIEW !== "0") {
      const repoRoot = findRepoRootFromDir(process.cwd());
      if (repoRoot) {
        const overview = tryLoadProjectOverview(repoRoot);
        if (overview) additionalContext += overview;
      }
    }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }));
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handleSessionGate
//
// PreToolUse hook with empty matcher (matches ALL tools). Blocks every tool
// EXCEPT the allow-list until a CodeSift tool has been called once
// (sentinel file). Inspired by cmm-claude-code-setup/session-gate.sh.
//
// Allow-list (always permitted):
//   - All mcp__codesift__* (so the agent CAN call them to release the gate)
//   - Agent (so subagents can spawn — they have their own gate)
//   - Skill, ToolSearch, SendMessage, TaskCreate, TaskUpdate, TaskList
//   - PushNotification, ScheduleWakeup
//
// Once any mcp__codesift__index_status / plan_turn / index_folder is called,
// the sentinel is created (by handleSentinelWriter PostToolUse) and all tools
// are unlocked for the rest of the session.
// ---------------------------------------------------------------------------

const SESSION_GATE_ALLOWLIST = new Set([
  "Agent", "Skill", "ToolSearch", "SendMessage",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
  "PushNotification", "ScheduleWakeup", "AskUserQuestion",
  "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
  "Monitor", "CronCreate", "CronList", "CronDelete", "RemoteTrigger",
]);

export async function handleSessionGate(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) { process.exit(0); return; }

    const { toolName, sessionId } = parseHookInput(raw);
    if (!toolName) { process.exit(0); return; }

    // Allow CodeSift tools (they release the gate)
    if (toolName.startsWith("mcp__codesift__")) {
      process.exit(0); return;
    }

    // Allow infrastructure tools
    if (SESSION_GATE_ALLOWLIST.has(toolName)) {
      process.exit(0); return;
    }

    // Allow other MCP tools (sentry, playwright, etc. — not our concern)
    if (toolName.startsWith("mcp__") && !toolName.startsWith("mcp__codesift__")) {
      process.exit(0); return;
    }

    // Check sentinel — has CodeSift been called yet?
    const sentinel = getSessionSentinelPath(sessionId);
    if (existsSync(sentinel)) {
      process.exit(0); return;
    }

    // Block — agent must call CodeSift first
    denyTool(
      `CodeSift session not initialized. Call one of these first:\n` +
        `  mcp__codesift__index_status() — check if repo is indexed\n` +
        `  mcp__codesift__plan_turn(query="...") — natural-language tool router\n` +
        `  mcp__codesift__get_file_tree() — list repo files\n` +
        `Then '${toolName}' will be allowed.`,
    );
  } catch {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handleSentinelWriter
//
// PostToolUse hook for mcp__codesift__* tools. Creates the session-ready
// sentinel so subsequent tool calls pass the SessionGate.
// ---------------------------------------------------------------------------

export async function handleSentinelWriter(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) { process.exit(0); return; }

    const { sessionId } = parseHookInput(raw);
    const sentinel = getSessionSentinelPath(sessionId);
    try {
      mkdirSync(dirname(sentinel), { recursive: true });
      writeFileSync(sentinel, String(Date.now()), "utf-8");
    } catch { /* best-effort */ }
    process.exit(0);
  } catch {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// handlePrecheckAgent
//
// PreToolUse hook for the Agent tool. Blocks Task/Explore subagent spawns
// whose prompt does NOT reference CodeSift tool names. Forces parent agent
// to either do the work itself with CodeSift, or pass CodeSift tool names
// in the subagent prompt. Inspired by cmm/agent-cmm-gate.sh.
// ---------------------------------------------------------------------------

const CODESIFT_TOOL_KEYWORDS = [
  "search_text", "search_symbols", "get_file_tree", "get_file_outline",
  "get_symbol", "get_symbols", "find_references", "trace_call_chain",
  "trace_route", "codebase_retrieval", "assemble_context", "plan_turn",
  "find_dead_code", "scan_secrets", "review_diff", "audit_scan",
  "detect_communities", "analyze_complexity", "analyze_hotspots",
  "impact_analysis", "find_and_show", "discover_tools", "describe_tools",
  "codesift", "CodeSift",
];

export async function handlePrecheckAgent(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) { process.exit(0); return; }

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { process.exit(0); return; }
    if (!parsed || typeof parsed !== "object") { process.exit(0); return; }

    const obj = parsed as Record<string, unknown>;
    const ti = obj["tool_input"] as Record<string, unknown> | undefined;
    if (!ti) { process.exit(0); return; }

    const subagentType = typeof ti["subagent_type"] === "string" ? ti["subagent_type"] : "";
    const prompt = typeof ti["prompt"] === "string" ? ti["prompt"] : "";

    // Only gate code-exploration subagents
    if (subagentType !== "Explore" && subagentType !== "general-purpose" && subagentType !== "Plan") {
      process.exit(0); return;
    }

    // Allow if prompt mentions any CodeSift keyword
    const lower = prompt.toLowerCase();
    if (CODESIFT_TOOL_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) {
      process.exit(0); return;
    }

    // Detect code-search intent — block these
    const CODE_SEARCH_INTENT = /\b(find|search|investigate|trace|explore|locate|grep|look\s+for|where\s+is|how\s+does|what\s+calls)\b.*\b(code|file|function|class|module|component|symbol|import|method|hook|route|endpoint|service|handler|in\s+the\s+(codebase|project|repo))\b/i;
    if (CODE_SEARCH_INTENT.test(prompt)) {
      // Code search detected without CodeSift keywords — block
    } else if (prompt.length < 200) {
      // Non-code-search short prompt — allow
      process.exit(0); return;
    }

    // Block — subagent prompt should reference CodeSift tools
    denyTool(
      `Subagent '${subagentType}' prompt does not mention any CodeSift tool.\n` +
        `Explore subagent does NOT have access to mcp__codesift__* tools — it will use Grep/Glob/Read.\n` +
        `Either:\n` +
        `  1. Add CodeSift tool names to the subagent prompt (search_text, get_file_tree, etc.)\n` +
        `  2. Do the work yourself using mcp__codesift__* tools — usually faster and cheaper`,
    );
  } catch {
    process.exit(0);
  }
}
