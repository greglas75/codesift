import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { isTestFileStrict } from "../../utils/test-file.js";
import {
  CODE_EXTENSIONS, denyTool, findIndexedRepo, isCodesiftServerRunning, isPathInIndexedRepo, sqliteArtifactPath,
} from "./shared.js";
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
}

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

function entrySearched(entry: TranscriptEntry, terms: readonly string[]): boolean {
  if (entry.type !== "assistant") return false;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    return b?.type === "tool_use" && typeof b.name === "string" && isSearchToolUse(b.name, b.input) &&
      lookupNames(b.name, b.input, terms);
  });
}

/**
 * Walk transcript lines from the newest: a search naming one of `terms` before
 * reaching the latest human prompt → true; the prompt first → false. `null` =
 * could not tell. No `terms` (the default): any search counts.
 */
export function searchedSinceLastPrompt(linesNewestFirst: Iterable<string>, terms: readonly string[] = []): boolean | null {
  for (const line of linesNewestFirst) {
    // Cheap filters first: most lines are attachments, api records and huge tool results. A tool result
    // is neither a lookup nor a prompt; the unescaped marker cannot occur inside prompt text (JSON escapes it).
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    if (line.includes('"type":"tool_result"')) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (entrySearched(entry, terms)) return true;
    if (isHumanPrompt(entry)) return false;
  }
  return null;
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
const NOISE_DIRS = /(^|[\\/])(node_modules|dist|build|coverage|\.next|vendor)[\\/]/;

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
 * The existing files that most likely already do the job of the new file, best first. A candidate must contain a
 * every word of a one- or two-word stem, all but one of a longer one (folder words alone match every file of a big
 * folder — noise, and so does one word of a name); a stem word counts double a folder word, shorter paths win ties. `stem` empty (a name made of generic words): folder words decide.
 */
export function rankExistingFiles(
  paths: readonly string[],
  terms: { stem: readonly string[]; folder: readonly string[] },
  selfPath: string,
  limit = HINT_LIMIT,
): string[] {
  const own = terms.stem.length > 0 ? terms.stem : terms.folder;
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
  return scored.slice(0, limit).map((r) => r.path);
}

/**
 * Existing symbols whose name holds EVERY word of the new file's stem (case-insensitive), best first: the exact
 * name (`formatPercentLabel` for `format-percent-label.ts`) before partial ones, then the shortest name.
 */
export function rankExistingSymbols(
  rows: readonly SymbolRow[],
  stemWords: readonly string[],
  limit = HINT_LIMIT,
): SymbolRow[] {
  if (stemWords.length === 0) return [];
  const exact = stemWords.join("");
  const seen = new Set<string>();
  const kept: Array<SymbolRow & { rank: number }> = [];
  for (const row of rows) {
    const lower = row.name.toLowerCase();
    const key = `${row.name}\u0000${row.file}`;
    if (seen.has(key) || !HINT_SYMBOL_KINDS.includes(row.kind) || !isCandidateSource(row.file)) continue;
    if (!stemWords.every((w) => lower.includes(w))) continue;
    seen.add(key);
    kept.push({ ...row, rank: lower.replace(/[^\p{L}\p{N}]/gu, "") === exact ? 0 : 1 });
  }
  kept.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.file.localeCompare(b.file) || a.start_line - b.start_line);
  return kept.slice(0, limit).map(({ rank: _rank, ...row }) => row);
}

/** The deny message's "what already exists" block; `null` when there is nothing to show. */
export function formatExistingCode(hits: ExistingCode | null): string | null {
  if (!hits || (hits.files.length === 0 && hits.symbols.length === 0)) return null;
  const lines = ["Existing code that may already do this:"];
  for (const f of hits.files) lines.push(`  file   ${f}`);
  for (const s of hits.symbols) lines.push(`  symbol ${s.name} (${s.kind}) — ${s.file}:${s.start_line}`);
  return lines.join("\n");
}

/** SQLite URI for a read-only open: `%`, `?` and `#` of the path would otherwise be read as URI syntax. */
function readOnlyUri(dbPath: string): string {
  return `file:${dbPath.replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23")}?mode=ro`;
}

/**
 * Look the new file's name up in the repo's SQLite index — plain name matches, no embeddings (too slow for a hook
 * process). Opens the database read-only through the storage layer's own constructor (so the native store, when
 * on, stays the only SQLite copy in the process) and imports it lazily: the allow path never pays for it. Any
 * failure or a blown budget gives `null` — the caller then sends the plain message.
 */
export async function lookupExistingCode(filePath: string, budgetMs = HINT_BUDGET_MS): Promise<ExistingCode | null> {
  const started = Date.now();
  const repo = findIndexedRepo(filePath);
  if (!repo) return null;
  const dbPath = sqliteArtifactPath(repo.indexPath);
  if (!existsSync(dbPath)) return null;
  const selfPath = relative(repo.root, filePath).split(sep).join("/");
  const terms = nameTerms(filePath);
  const stemWords = words(basename(filePath).replace(/\.[^.]+$/, "")).filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
  const fileTerms = terms.stem.length > 0 ? terms.stem : terms.folder;
  if (fileTerms.length === 0 && stemWords.length === 0) return null;

  const { loadSqliteCtor } = await import("../../storage/sqlite/runtime.js");
  const Ctor = await loadSqliteCtor();
  if (!Ctor || Date.now() - started > budgetMs) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new Ctor(readOnlyUri(dbPath));
    db.exec("PRAGMA busy_timeout = 100");
    const out: ExistingCode = { files: [], symbols: [] };
    if (fileTerms.length > 0) {
      // Most matching words first: with only a length order, short paths holding one common word fill the cap.
      const hit = fileTerms.map(() => "(path LIKE ?)").join(" + ");
      const patterns = fileTerms.map((t) => `%${t}%`);
      const rows = db.prepare(
        `SELECT path FROM files WHERE ${fileTerms.map(() => "path LIKE ?").join(" OR ")} ORDER BY ${hit} DESC, length(path) LIMIT 300`,
      ).all(...patterns, ...patterns) as Array<{ path: string }>;
      out.files = rankExistingFiles(rows.map((r) => r.path), terms, selfPath);
    }
    if (stemWords.length > 0 && Date.now() - started < budgetMs) {
      // Two steps on purpose: `name LIKE` alone scans the narrow `idx_symbols_name` (58 ms warm, 0.55 s cold on a
      // 596k-symbol index), while adding `kind`/`file` conditions makes SQLite walk the whole table (4.7 s cold).
      // Test-case and suite names hold spaces, identifiers never do, so `NOT LIKE '% %'` keeps them out of the cap.
      const ids = db.prepare(
        `SELECT rowid AS id FROM symbols WHERE ${stemWords.map(() => "name LIKE ?").join(" AND ")} AND name NOT LIKE '% %' ` +
        "ORDER BY length(name) LIMIT 150",
      ).all(...stemWords.map((w) => `%${w}%`)) as Array<{ id: number }>;
      if (ids.length > 0 && Date.now() - started < budgetMs) {
        const rows = db.prepare(
          `SELECT name, kind, file, start_line FROM symbols WHERE rowid IN (${ids.map(() => "?").join(",")})`,
        ).all(...ids.map((r) => r.id)) as unknown as SymbolRow[];
        out.symbols = rankExistingSymbols(rows, stemWords);
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

/** `lookupExistingCode` under a hard clock that also covers the lazy import; never rejects. */
async function existingCodeHint(filePath: string): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), HINT_BUDGET_MS + 100);
    });
    return formatExistingCode(await Promise.race([lookupExistingCode(filePath), timeout]));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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
  transcriptPath: string | null;
  agentId: string | null;
}

export function parseWriteHookInput(raw: string): WriteHookInput {
  const empty: WriteHookInput = { filePath: null, transcriptPath: null, agentId: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const obj = parsed as Record<string, unknown>;
  const toolInput = obj["tool_input"] && typeof obj["tool_input"] === "object"
    ? (obj["tool_input"] as Record<string, unknown>)
    : {};
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    filePath: str(toolInput["file_path"]),
    transcriptPath: str(obj["transcript_path"]),
    agentId: str(obj["agent_id"]),
  };
}

export async function handlePrecheckWrite(): Promise<void> {
  try {
    if (process.env["CODESIFT_SEARCH_FIRST"] === "0") return process.exit(0);
    const raw = readRawInput();
    if (!raw) return process.exit(0);
    const { filePath, transcriptPath, agentId } = parseWriteHookInput(raw);
    if (!filePath || !transcriptPath || !isGatedNewFile(filePath) || !isPathInIndexedRepo(filePath)) {
      return process.exit(0);
    }
    const transcript = transcriptFor(transcriptPath, agentId);
    if (!transcript || !existsSync(transcript)) return process.exit(0);
    const terms = relevantTerms(filePath);
    if (searchedSinceLastPrompt(readLinesBackward(transcript), terms) !== false) return process.exit(0);
    denyTool(denyReason(filePath, isCodesiftServerRunning(), terms, await existingCodeHint(filePath)));
  } catch {
    process.exit(0);
  }
}
