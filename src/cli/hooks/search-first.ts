import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sqlitePathFor } from "../../storage/index-paths.js";
import { isTestFileStrict } from "../../utils/test-file.js";
import { CODE_EXTENSIONS, denyTool, findIndexedRepo, isCodesiftServerRunning, isPathInIndexedRepo } from "./shared.js";
import { readRawInput } from "./input.js";

/**
 * Search-first gate (PreToolUse Write).
 *
 * Agents duplicate code because nothing makes them look before they write: the
 * grep/find/Read hooks only reroute a search the agent already decided to do, so
 * an agent that goes straight to "create helpers/formatPercent.ts" never meets
 * any of them. This gate fires on exactly that moment — a NEW production source
 * file inside an indexed repo — and asks for one lookup since the last human
 * prompt that names the new code (a word of its file name or folder) before the
 * file may be created. Any repo search tool counts (CodeSift discovery tools,
 * Grep/Glob, grep/rg in Bash, an Explore agent), so the gate never demands a
 * capability the caller lacks. 2026-11-13: when ANY lookup unlocked it, the gate
 * almost never fired — agents always search for something before writing.
 *
 * Codex has no Write tool: it creates files through `apply_patch`, whose PreToolUse payload carries the patch in
 * `tool_input.command`. Every `*** Add File:` of the patch is gated the same way, and the lookups are read from the
 * Codex rollout (`transcript_path`): `McpToolCall` / `CommandExecution` items, the prompt boundary is a `UserMessage`.
 *
 * It fails OPEN everywhere: an unreadable or missing transcript, a transcript
 * too large to scan, an unknown hook payload — all allow. A false deny stops
 * real work; a missed nudge only costs what we have today.
 */

/** CodeSift tools that answer "does this already exist?". Matched on the name after the last `__`. */
const CODESIFT_DISCOVERY_TOOLS: ReadonlySet<string> = new Set([
  "search_symbols", "search_text", "semantic_search", "codebase_retrieval", "find_and_show",
  "find_clones", "find_references", "plan_turn", "get_file_tree", "get_file_outline",
  "assemble_context", "get_context_bundle", "get_symbols", "search_patterns",
]);

const NATIVE_SEARCH_TOOLS: ReadonlySet<string> = new Set(["Grep", "Glob"]);

const SHELL_SEARCH = /(?:^|[\s;&|(`])(?:rg|grep|egrep|ag|ack)\s|git\s+grep\s|codesift\s+(?:search|symbols|find|find-clones|refs|context|retrieve|dup-check)\b/;

/** Stop scanning backwards after this much transcript: beyond it the answer is "unknown" (allow). */
const MAX_SCAN_BYTES = 48 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

interface TranscriptEntry {
  type?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  origin?: { kind?: unknown } | null;
  message?: { content?: unknown } | null;
  /** A Codex rollout line: `{ type: "event_msg", payload: { type: "item_completed", item } }`. */
  payload?: { type?: unknown; item?: unknown } | null;
}

/** What one Codex rollout line says about the task window: a human prompt, a lookup, or neither. */
type CodexEvent = { kind: "prompt" } | { kind: "tool"; name: string; input: unknown };

/** File-name words too generic to say what a file does: a lookup for them proves nothing. */
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "index", "main", "utils", "util", "helper", "helpers", "types", "type", "constants", "config", "common", "shared",
  "service", "services", "component", "components", "hooks", "model", "models", "module", "lib", "core", "base",
  "src", "app", "apps", "packages", "page", "pages", "view", "views", "store", "api", "new", "data",
]);

/** Split an identifier or phrase into lower-case words: kebab, snake, camel and acronym (`HTTPClient`) boundaries. */
function words(text: string): string[] {
  return text
    .replace(/\\[A-Za-z]/g, " ") // regex escapes: `\bpercent\b` searches for "percent", not "bpercent"
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u) // letters of any script: `płatności` is one word, not `p`/`atno`/`ci`
    .filter(Boolean);
}

/**
 * Words a lookup must name to count for `filePath`: the words of the file stem and its folder, at least 4 letters,
 * generic ones dropped. Empty → nothing specific to ask for, and any lookup counts.
 */
export function relevantTerms(filePath: string): string[] {
  const { stem, folder } = nameTerms(filePath);
  return [...new Set([...stem, ...folder])];
}

/** `relevantTerms`, kept apart: the words of the file stem and of its folder (a stem word says more than a folder word). */
function nameTerms(filePath: string): { stem: string[]; folder: string[] } {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  const stem = (parts.pop() ?? "").replace(/\.[^.]+$/, "");
  const folder = parts.pop() ?? "";
  const keep = (text: string) => [...new Set(words(text).filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w)))];
  return { stem: keep(stem), folder: keep(folder) };
}

/**
 * The fields of a lookup that hold what the agent searched FOR. Paths, repo names and options do not count: a
 * search scoped to the right folder for an unrelated symbol is not a look at the new code, and matching key names
 * would let `query.ts` unlock on every `{ query: … }`. find_clones has no query; its file_pattern is the lookup.
 * A shell command and an agent prompt count whole (their paths too): telling the searched word from the scope in
 * free text is guesswork, and a false unlock only costs a missed nudge, while a false deny stops real work. For the
 * same reason a file whose name has no usable word (all generic, under 4 letters, non-ASCII) keeps any-lookup.
 */
const LOOKUP_FIELDS: ReadonlySet<string> = new Set(["query", "queries", "pattern", "command", "prompt", "symbol_name", "name_pattern"]);

function lookupText(name: string, input: unknown, depth = 0): string[] {
  if (!input || typeof input !== "object" || depth > 2) return [];
  const keys = name.endsWith("find_clones") ? new Set([...LOOKUP_FIELDS, "file_pattern"]) : LOOKUP_FIELDS;
  const out: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!keys.has(k)) continue;
    for (const item of Array.isArray(v) ? v : [v]) {
      if (typeof item === "string") out.push(item);
      else out.push(...lookupText(name, item, depth + 1)); // codebase_retrieval: queries = [{ type, query }]
    }
  }
  return out;
}

/**
 * Does this lookup name any of `terms`? A term matches a searched word that starts with the term's first 6 letters
 * (plural, `-ing`, `formatting` for `format`), or a word of 4+ letters the term starts with (`auth` for
 * `authentication`). Whole words only: `date` must not match `update`. No terms: every lookup counts.
 */
export function lookupNames(name: string, input: unknown, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const searched = lookupText(name, input).flatMap(words);
  return terms.some((t) => {
    const head = t.slice(0, 6);
    return searched.some((w) => w.startsWith(head) || (w.length >= 4 && t.startsWith(w)));
  });
}

/** A tool_use block that looked something up in the repo. */
export function isSearchToolUse(name: string, input: unknown): boolean {
  if (NATIVE_SEARCH_TOOLS.has(name)) return true;
  if (name.startsWith("mcp__") && name.includes("codesift")) {
    return CODESIFT_DISCOVERY_TOOLS.has(name.slice(name.lastIndexOf("__") + 2));
  }
  const fields = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (name === "Bash") return typeof fields["command"] === "string" && SHELL_SEARCH.test(fields["command"]);
  if (name === "Agent" || name === "Task") return fields["subagent_type"] === "Explore";
  return false;
}

/**
 * A prompt the human typed (or a subagent's brief), which opens a new task window.
 * Tool results, skill bodies (`isMeta`), compaction summaries and background-task
 * notifications are user-role lines too, but none of them starts new work.
 */
export function isHumanPrompt(entry: TranscriptEntry): boolean {
  if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true) return false;
  const kind = entry.origin?.kind ?? "human";
  if (kind !== "human") return false;
  const content = entry.message?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && !content.some((b) => (b as { type?: unknown })?.type === "tool_result");
}

/** The lookups (tool_use blocks that searched the repo) of a Claude assistant record. */
function searchesIn(entry: TranscriptEntry): Array<{ name: string; input: unknown }> {
  if (entry.type !== "assistant") return [];
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ name: string; input: unknown }> = [];
  for (const block of content) {
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    if (b?.type === "tool_use" && typeof b.name === "string" && isSearchToolUse(b.name, b.input)) out.push({ name: b.name, input: b.input });
  }
  return out;
}

/**
 * The script of `["/bin/bash", "-lc", "<script>"]` (also `-l -c`, `zsh`, `sh`): the argument after the first `-…c`
 * flag, only when argv[0] is a shell. Any other program (`python -c`, `node -c`) keeps its whole argv as the command.
 */
function shellScript(argv: string[]): string {
  const shell = /^(?:.*[\\/])?(?:bash|sh|zsh)$/.test(argv[0] ?? "");
  if (shell) {
    for (let i = 1; i < argv.length - 1; i++) {
      const arg = argv[i] as string;
      if (!arg.startsWith("-")) break;
      if (/^-\w*c$/.test(arg)) return argv[i + 1] as string;
    }
  }
  return argv.join(" ");
}

/**
 * A Codex rollout line (`event_msg` / `item_completed`) as a prompt or a tool call, in the shape the Claude helpers
 * already judge: an MCP call is `mcp__<server>__<tool>` with its arguments, a command is a `Bash` call (Codex
 * wraps it as `["/bin/bash","-lc","<script>"]`). The model batches calls in one `exec` script, but every nested
 * call still lands as its own item, finished before the next PreToolUse hook fires.
 */
export function codexEvent(entry: TranscriptEntry): CodexEvent | null {
  if (entry.type !== "event_msg" || entry.payload?.type !== "item_completed") return null;
  const item = entry.payload.item as Record<string, unknown> | null | undefined;
  if (!item || typeof item !== "object") return null;
  if (item["type"] === "UserMessage") return { kind: "prompt" };
  if (item["type"] === "McpToolCall" && typeof item["server"] === "string" && typeof item["tool"] === "string") {
    return { kind: "tool", name: `mcp__${item["server"]}__${item["tool"]}`, input: item["arguments"] };
  }
  const argv = item["command"];
  if (item["type"] === "CommandExecution" && Array.isArray(argv) && argv.every((a) => typeof a === "string")) {
    return { kind: "tool", name: "Bash", input: { command: shellScript(argv as string[]) } };
  }
  return null;
}

/** Lines worth parsing: Claude user/assistant records and the three Codex item kinds. The markers are unescaped, so they cannot occur inside text. */
const TRANSCRIPT_MARKERS = ['"type":"user"', '"type":"assistant"', '"type":"UserMessage"', '"type":"McpToolCall"', '"type":"CommandExecution"'];

/**
 * Walk transcript lines from the newest ONCE for several term sets (one per new file): a search naming one of a set's
 * terms before the latest human prompt → true for it; the prompt first → false; `null` = could not tell. No terms: any
 * search counts. Reads Claude Code JSONL and Codex rollouts alike.
 */
export function searchedSinceLastPromptEach(linesNewestFirst: Iterable<string>, termSets: ReadonlyArray<readonly string[]>): Array<boolean | null> {
  const result: Array<boolean | null> = termSets.map(() => null);
  let open = termSets.map((_, i) => i);
  for (const line of linesNewestFirst) {
    // Cheap filters first: most lines are attachments, api records and huge tool results. A tool result
    // is neither a lookup nor a prompt; the unescaped marker cannot occur inside prompt text (JSON escapes it).
    if (!TRANSCRIPT_MARKERS.some((m) => line.includes(m))) continue;
    if (line.includes('"type":"tool_result"')) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    const codex = codexEvent(entry);
    let searches: Array<{ name: string; input: unknown }>;
    let prompt: boolean;
    if (codex) {
      prompt = codex.kind === "prompt";
      searches = codex.kind === "tool" && isSearchToolUse(codex.name, codex.input) ? [codex] : [];
    } else {
      searches = searchesIn(entry);
      prompt = searches.length === 0 && isHumanPrompt(entry);
    }
    open = open.filter((i) => {
      if (searches.some((q) => lookupNames(q.name, q.input, termSets[i] as readonly string[]))) {
        result[i] = true;
        return false;
      }
      if (prompt) {
        result[i] = false;
        return false;
      }
      return true;
    });
    if (open.length === 0) break; // every file answered: do not read further back
  }
  return result;
}

/** `searchedSinceLastPromptEach` for one file. */
export function searchedSinceLastPrompt(linesNewestFirst: Iterable<string>, terms: readonly string[] = []): boolean | null {
  return searchedSinceLastPromptEach(linesNewestFirst, [terms])[0] ?? null;
}

/** Lines of a JSONL file, newest first, read in chunks from the end. Stops at `maxBytes`. */
export function* readLinesBackward(path: string, maxBytes = MAX_SCAN_BYTES, chunkBytes = CHUNK_BYTES): Generator<string> {
  const fd = openSync(path, "r");
  try {
    let position = fstatSync(fd).size;
    const floor = Math.max(0, position - maxBytes);
    let carry = Buffer.alloc(0);
    while (position > floor) {
      const size = Math.min(chunkBytes, position - floor);
      position -= size;
      const chunk = Buffer.alloc(size);
      // A short read would leave zero bytes in the chunk: give up (the caller fails open).
      if (readSync(fd, chunk, 0, size, position) !== size) return;
      const data = Buffer.concat([chunk, carry]);
      // Split on bytes, not on a decoded string: a chunk boundary may fall inside a multi-byte character.
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 10) continue;
        if (end > i + 1) yield data.subarray(i + 1, end).toString("utf-8");
        end = i;
      }
      carry = data.subarray(0, end);
    }
    // The first line is complete only when the whole file was read.
    if (position === 0 && carry.length > 0) yield carry.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/** A subagent's own transcript: `<dir>/<session>/subagents/agent-<id>.jsonl` beside the session's. */
export function transcriptFor(transcriptPath: string, agentId: string | null): string | null {
  if (!agentId) return transcriptPath;
  const sessionDir = transcriptPath.replace(/\.jsonl$/, "");
  const agentPath = join(sessionDir, "subagents", `agent-${agentId}.jsonl`);
  return existsSync(agentPath) ? agentPath : null;
}

/** Only brand-new production source files are gated: edits, tests, declarations and generated output are not. */
export function isGatedNewFile(filePath: string): boolean {
  if (!CODE_EXTENSIONS.has(extname(filePath).toLowerCase())) return false;
  if (filePath.endsWith(".d.ts") || isTestFileStrict(filePath)) return false;
  if (/(^|[\\/])(node_modules|dist|build|coverage|\.next|vendor)[\\/]/.test(filePath)) return false;
  return !existsSync(filePath);
}

/** Total time the existing-code lookup may take; past it the plain message is sent (the hook must stay well under 1 s). */
const HINT_BUDGET_MS = 400;
const HINT_LIMIT = 3;
const HINT_SYMBOL_KINDS: readonly string[] = ["function", "class", "interface", "type", "method", "component", "hook", "enum"];
const NOISE_DIR_NAMES: readonly string[] = ["node_modules", "dist", "build", "coverage", ".next", "vendor"];
const NOISE_DIRS = new RegExp(`(^|[\\\\/])(${NOISE_DIR_NAMES.map((d) => d.replace(".", "\\.")).join("|")})[\\\\/]`);
/** Source extensions as SQL (`LIKE` ignores ASCII case, as `extname(...).toLowerCase()` does). */
const CODE_EXTENSIONS_SQL = `(${[...CODE_EXTENSIONS].map((e) => `path LIKE '%${e}'`).join(" OR ")})`;
/** The same directories as SQL, anchored on a path segment (`%dist/%` alone would drop `redist/x.ts`). */
const NOISE_DIRS_SQL = NOISE_DIR_NAMES.map((d) => `path NOT LIKE '${d}/%' AND path NOT LIKE '%/${d}/%'`).join(" AND ");

export interface SymbolRow {
  name: string;
  kind: string;
  file: string;
  start_line: number;
}

export interface ExistingCode {
  files: string[];
  symbols: SymbolRow[];
}

/** Repo-relative path of an existing production source file that could be a duplicate: no tests, declarations, build output. */
function isCandidateSource(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase()) && !path.endsWith(".d.ts") &&
    !isTestFileStrict(`/${path}`) && !NOISE_DIRS.test(path);
}

/**
 * The existing files that most likely already do the job of the new file, best first. A candidate must contain
 * every word of a one- or two-word stem, all but one of a longer one (folder words alone match every file of a big
 * folder — noise, and so does one word of a name); a stem word counts double a folder word, shorter paths win
 * ties. `stem` empty (a name made of generic words): folder words decide. `exists` drops what a stale index still
 * lists (asked in ranked order, so a few `stat`s at most).
 */
export function rankExistingFiles(
  paths: readonly string[],
  terms: { stem: readonly string[]; folder: readonly string[] },
  selfPath: string,
  limit = HINT_LIMIT,
  exists: (path: string) => boolean = () => true,
): string[] {
  const own = terms.stem.length > 0 ? terms.stem : terms.folder;
  if (own.length === 0) return []; // no word to match: every file would "match"
  const other = terms.stem.length > 0 ? terms.folder : [];
  // All words of a one- or two-word name (a lone `format` is a coincidence); one may differ in a longer one.
  const need = own.length >= 3 ? own.length - 1 : own.length;
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of new Set(paths)) {
    if (path === selfPath || !isCandidateSource(path)) continue;
    const lower = path.toLowerCase();
    const ownHits = own.filter((t) => lower.includes(t)).length;
    if (ownHits < need) continue;
    scored.push({ path, score: 2 * ownHits + other.filter((t) => lower.includes(t)).length });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  const kept: string[] = [];
  for (const { path } of scored) {
    if (kept.length >= limit) break; // ranked order, stop at the cap: at most `limit` + the stale ones `stat`ed
    if (exists(path)) kept.push(path);
  }
  return kept;
}

/**
 * Existing symbols whose name holds EVERY word of the new file's stem (case-insensitive), best first: the exact
 * name (`formatPercentLabel` for `format-percent-label.ts`) before partial ones, then the shortest name.
 */
export function rankExistingSymbols(
  rows: readonly SymbolRow[],
  stemWords: readonly string[],
  limit = HINT_LIMIT,
  exists: (path: string) => boolean = () => true,
): SymbolRow[] {
  if (stemWords.length === 0) return [];
  const wanted = stemWords.map((w) => w.toLowerCase());
  const exact = wanted.join("");
  const seen = new Set<string>();
  const kept: Array<SymbolRow & { rank: number }> = [];
  for (const row of rows) {
    const lower = row.name.toLowerCase();
    const key = `${row.name}\u0000${row.file}`;
    if (seen.has(key) || !HINT_SYMBOL_KINDS.includes(row.kind) || !isCandidateSource(row.file)) continue;
    if (!wanted.every((w) => lower.includes(w))) continue;
    seen.add(key);
    kept.push({ ...row, rank: lower.replace(/[^\p{L}\p{N}]/gu, "") === exact ? 0 : 1 });
  }
  kept.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.file.localeCompare(b.file) || a.start_line - b.start_line);
  const out: SymbolRow[] = [];
  for (const { rank: _rank, ...row } of kept) {
    if (out.length >= limit) break;
    if (exists(row.file)) out.push(row);
  }
  return out;
}

/** The deny message's "what already exists" block; `null` when there is nothing to show. */
export function formatExistingCode(hits: ExistingCode | null): string | null {
  if (!hits || (hits.files.length === 0 && hits.symbols.length === 0)) return null;
  // Names come from the indexed repo: a newline or control character in one must not add lines to the message.
  const plain = (text: string) => text.replace(/[\p{Cc}\u2028\u2029]/gu, " ").slice(0, 200);
  const lines = ["Existing code that may already do this:"];
  for (const f of hits.files) lines.push(`  file   ${plain(f)}`);
  for (const s of hits.symbols) lines.push(`  symbol ${plain(s.name)} (${s.kind}) — ${plain(s.file)}:${s.start_line}`);
  return lines.join("\n");
}

/** What the lookup needs, as plain data: it crosses a process boundary. */
export interface LookupRequest {
  dbPath: string;
  root: string;
  selfPath: string;
  terms: { stem: string[]; folder: string[] };
  stemWords: string[];
  budgetMs: number;
}

/**
 * The index queries: plain name matches, no embeddings (too slow for a hook). The database is opened read-only
 * through the storage layer's own constructor (`loadSqliteCtor`: with the native store on, one SQLite copy owns
 * every index database in the process) and `query_only` backs the option on a Node that ignores it. Never throws;
 * `null` on any failure. Runs in a child process (`runInChild`) — see there for why.
 */
export async function queryExistingCode(req: LookupRequest): Promise<ExistingCode | null> {
  const started = Date.now();
  let db: DatabaseSync | undefined;
  try {
    const { loadSqliteCtor } = await import("../../storage/sqlite/runtime.js");
    const Ctor = await loadSqliteCtor();
    if (!Ctor) return null;
    // A live WAL index (the daemon or an indexer holds it) opens fine read-only; a writer's lock is waited out for 100 ms.
    db = new Ctor(req.dbPath, { readOnly: true, timeout: 100 });
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 100");
    const out: ExistingCode = { files: [], symbols: [] };
    const exists = (rel: string) => existsSync(join(req.root, rel));
    const fileTerms = req.terms.stem.length > 0 ? req.terms.stem : req.terms.folder;
    if (fileTerms.length > 0) {
      // Most matching words first, and non-source files/tests/declarations/build output/vendored code out in SQL, by the
      // same rules as `isCandidateSource`: neither a length order nor a post-filter may let discarded rows fill the cap.
      const hit = fileTerms.map(() => "(path LIKE ?)").join(" + ");
      const patterns = fileTerms.map((t) => `%${t}%`);
      const rows = db.prepare(
        `SELECT path FROM files WHERE (${fileTerms.map(() => "path LIKE ?").join(" OR ")}) ` +
        "AND path NOT LIKE '%.test.%' AND path NOT LIKE '%.spec.%' AND path NOT LIKE '%.d.ts' " +
        `AND ${CODE_EXTENSIONS_SQL} AND ${NOISE_DIRS_SQL} AND path NOT LIKE '%/__tests__/%' ` +
        `ORDER BY ${hit} DESC, length(path) LIMIT 600`,
      ).all(...patterns, ...patterns) as Array<{ path: string }>;
      out.files = rankExistingFiles(rows.map((r) => r.path), req.terms, req.selfPath, HINT_LIMIT, exists);
    }
    if (req.stemWords.length > 0 && Date.now() - started < req.budgetMs) {
      // Two steps on purpose: `name LIKE` alone scans the narrow `idx_symbols_name` (58 ms warm, 0.55 s cold on a
      // 596k-symbol index), while adding `kind`/`file` conditions makes SQLite walk the whole table (4.7 s cold).
      // Test-case and suite names hold spaces, identifiers never do, so `NOT LIKE '% %'` keeps them out of the cap.
      const ids = db.prepare(
        `SELECT rowid AS id FROM symbols WHERE ${req.stemWords.map(() => "name LIKE ?").join(" AND ")} AND name NOT LIKE '% %' ` +
        "ORDER BY length(name) LIMIT 500",
      ).all(...req.stemWords.map((w) => `%${w}%`)) as Array<{ id: number }>;
      if (ids.length > 0 && Date.now() - started < req.budgetMs) {
        const rows = db.prepare(
          `SELECT name, kind, file, start_line FROM symbols WHERE rowid IN (${ids.map(() => "?").join(",")}) ` +
          `AND kind IN (${HINT_SYMBOL_KINDS.map(() => "?").join(",")}) AND file NOT LIKE '%.test.%' AND file NOT LIKE '%.spec.%'`,
        ).all(...ids.map((r) => r.id), ...HINT_SYMBOL_KINDS) as unknown as SymbolRow[];
        out.symbols = rankExistingSymbols(rows, req.stemWords, HINT_LIMIT, exists);
      }
    }
    return out;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* closing a database that never opened */
    }
  }
}

/** Runs `exportName(request)` of `moduleUrl` and prints its JSON result: the child's whole program. */
const CHILD_BOOT =
  "import(process.argv[1]).then((m) => m[process.argv[2]](JSON.parse(process.argv[3])))" +
  ".then((v) => process.stdout.write(JSON.stringify({ ok: true, v })), () => process.stdout.write(JSON.stringify({ ok: false })));";

/** Why a child gave no answer: `null` stays "the export found nothing", a failure carries its reason. */
export type ChildFailure = "timeout" | "spawn" | "export" | "output";
export interface ChildResult<T> {
  value: T | null;
  failure?: ChildFailure;
}

/**
 * Call an async export of a module in a throw-away child process and give up after `timeoutMs`: the child is then
 * SIGKILLed (`failure: "timeout"`). A child, not a worker thread, because `node:sqlite` is synchronous: a query
 * on a cold 1 GB index cannot be interrupted from inside, `worker.terminate()` does not stop a thread that is in
 * native code, and `process.exit()` joins its workers — measured, a 55 s query held the exit for 55 s after the
 * timer fired. Never rejects.
 */
export function runInChild<T>(moduleUrl: string, exportName: string, request: unknown, timeoutMs: number): Promise<ChildResult<T>> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn> | undefined;
    const chunks: Buffer[] = []; // decoded once at the end: a multi-byte character may straddle two chunks
    let timer: NodeJS.Timeout | undefined;
    const done = (result: ChildResult<T>) => {
      clearTimeout(timer);
      try {
        child?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    try {
      timer = setTimeout(() => done({ value: null, failure: "timeout" }), timeoutMs);
      child = spawn(process.execPath, ["-e", CHILD_BOOT, moduleUrl, exportName, JSON.stringify(request)], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.once("error", () => done({ value: null, failure: "spawn" }));
      child.once("close", () => {
        try {
          const out = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { ok?: boolean; v?: T | null };
          done(out.ok === true ? { value: out.v ?? null } : { value: null, failure: "export" });
        } catch {
          done({ value: null, failure: "output" });
        }
      });
    } catch {
      done({ value: null, failure: "spawn" });
    }
  });
}

/** `HINT_BUDGET_MS`, overridable for a forced-timeout check (`CODESIFT_HINT_BUDGET_MS=1`). */
function hintBudgetMs(): number {
  const n = Number(process.env["CODESIFT_HINT_BUDGET_MS"]);
  return Number.isFinite(n) && n > 0 ? n : HINT_BUDGET_MS;
}

/**
 * The existing code that matches the new file's name, or `null` (no repo, no index, nothing to match, any failure,
 * budget spent). The registry and the index path are resolved here, cheaply; the queries run in a child process
 * so the budget is real. Under tsx/vitest (this module is a `.ts` file, which a plain `node` child cannot import)
 * they run in-process.
 */
export async function lookupExistingCode(filePath: string, budgetMs = hintBudgetMs()): Promise<ExistingCode | null> {
  const repo = findIndexedRepo(filePath);
  if (!repo) return null;
  const dbPath = sqlitePathFor(repo.indexPath);
  if (!existsSync(dbPath)) return null;
  const terms = nameTerms(filePath);
  const stemWords = words(basename(filePath).replace(/\.[^.]+$/, "")).filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
  if (terms.stem.length + terms.folder.length === 0 && stemWords.length === 0) return null;
  const request: LookupRequest = {
    dbPath,
    root: repo.root,
    selfPath: relative(repo.root, filePath).split(sep).join("/"),
    terms,
    stemWords,
    budgetMs,
  };
  if (import.meta.url.endsWith(".ts")) return queryExistingCode(request);
  const { value, failure } = await runInChild<ExistingCode>(import.meta.url, "queryExistingCode", request, budgetMs);
  if (failure) process.stderr.write(`[codesift] existing-code hint skipped (${failure})\n`);
  return value;
}

/** The deny message's block; never throws, and in the shipped build never blocks past the budget (the in-process `.ts` path is dev only). */
async function existingCodeHint(filePath: string): Promise<string | null> {
  try {
    return formatExistingCode(await lookupExistingCode(filePath));
  } catch {
    return null;
  }
}

function denyReason(filePath: string, serverRunning: boolean, terms: readonly string[], existing: string | null = null): string {
  const stem = basename(filePath).replace(/\.[^.]+$/, "");
  const dir = basename(dirname(filePath));
  const lookups = serverRunning
    ? `  search_symbols(query="${stem}")                 — same name or shape\n` +
      `  semantic_search(query="<what the new code does>") — same job under another name\n` +
      `  find_clones(file_pattern="${dir}")                — copies already in that area`
    : `  grep -rn "<key identifier>" <src dir>  — same name or shape`;
  return (
    `New source file ${JSON.stringify(stem + extname(filePath))}: check whether this already exists before creating it.\n` +
    (existing ? `${existing}\n` : "") +
    `${lookups}\n` +
    `Reuse or extend what you find; if nothing fits, write the file again — one lookup since the last prompt ` +
    (terms.length ? `whose query names this code (${terms.map((t) => JSON.stringify(t)).join(" or ")}) unlocks it.\n` : `unlocks it.\n`) +
    `(CODESIFT_SEARCH_FIRST=0 turns this gate off.)`
  );
}

interface WriteHookInput {
  filePath: string | null;
  /** Codex `apply_patch`: every `*** Add File:` of the patch, absolute. Empty for a Claude `Write`. */
  patchFiles: string[];
  transcriptPath: string | null;
  agentId: string | null;
}

/** Strings of a tool payload that hold a Codex patch (`tool_input.command`, or `arguments` on other builds). */
function patchTexts(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  if (typeof node === "string") {
    if (node.includes("*** Begin Patch")) out.push(node);
  } else if (Array.isArray(node)) {
    for (const v of node) patchTexts(v, out, depth + 1);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) patchTexts(v, out, depth + 1);
  }
  return out;
}

/** The files a Codex patch creates (`*** Add File:`), resolved against the payload's `cwd`. Updates, moves and deletes are not new code. */
export function addedFilesFromPatch(patch: string, cwd: string | null): string[] {
  const out: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* Add File: (.+?)\s*$/gm)) {
    const path = match[1] as string;
    out.push(isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path));
  }
  return out;
}

/** A payload field some builds send as a JSON-encoded string (`"{\"command\":\"*** Begin Patch…\"}"`). */
function decoded(value: unknown): unknown {
  if (typeof value !== "string" || !value.trimStart().startsWith("{")) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function parseWriteHookInput(raw: string): WriteHookInput {
  const empty: WriteHookInput = { filePath: null, patchFiles: [], transcriptPath: null, agentId: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const obj = parsed as Record<string, unknown>;
  const input = decoded(obj["tool_input"]);
  const toolInput = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const filePath = str(toolInput["file_path"]);
  const patchFiles = filePath
    ? []
    : [...new Set(patchTexts([input, decoded(obj["arguments"])]).flatMap((p) => addedFilesFromPatch(p, str(obj["cwd"]))))];
  return { filePath, patchFiles, transcriptPath: str(obj["transcript_path"]), agentId: str(obj["agent_id"]) };
}

export async function handlePrecheckWrite(): Promise<void> {
  try {
    if (process.env["CODESIFT_SEARCH_FIRST"] === "0") return process.exit(0);
    const raw = readRawInput();
    if (!raw) return process.exit(0);
    const { filePath, patchFiles, transcriptPath, agentId } = parseWriteHookInput(raw);
    const created = (filePath ? [filePath] : patchFiles).filter((f) => isGatedNewFile(f) && isPathInIndexedRepo(f));
    if (!transcriptPath || created.length === 0) return process.exit(0);
    // A Codex thread's rollout is its own (subagents get theirs): only Claude keeps subagent transcripts beside the session's.
    const transcript = filePath ? transcriptFor(transcriptPath, agentId) : transcriptPath;
    if (!transcript || !existsSync(transcript)) return process.exit(0);
    // One pass over the rollout for every new file of the patch.
    const verdicts = searchedSinceLastPromptEach(readLinesBackward(transcript), created.map(relevantTerms));
    const unsearched = created.filter((_, i) => verdicts[i] === false);
    const [first, ...others] = unsearched;
    if (!first) return process.exit(0);
    const reason = denyReason(first, isCodesiftServerRunning(), relevantTerms(first), await existingCodeHint(first));
    const alsoNew = others.length > 0 ? `\nAlso new in this patch, not looked up yet: ${others.map((f) => JSON.stringify(basename(f))).join(", ")}.` : "";
    denyTool(reason + alsoNew);
  } catch {
    process.exit(0);
  }
}
