import { appendFile, mkdir } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Session ID — unique per process lifetime
// ---------------------------------------------------------------------------

const SESSION_ID = randomUUID();

/**
 * Machine identity stamped on every entry so logs merged across machines
 * (laptop + VPS, see usage-remote/) stay attributable.
 *
 * `os.hostname()` alone is NOT stable: on macOS it follows DHCP/network state
 * and returns a different string over the life of one machine — a single Mac
 * produced four identities in `usage.jsonl` ("greg-m5", the .local name, "Mac",
 * and a bare IP), splitting its own stats four ways. An explicit
 * CODESIFT_HOST_TAG still wins, but when it is absent (a GUI app launched
 * before `launchctl setenv` never sees it) we fall back to a machine-local id
 * persisted once under the data dir, so the identity survives renames.
 */
/**
 * A stable, machine-local identifier that no rename, DHCP lease or missing env var can change.
 *
 * `resolveHostTag` is a NAME, chosen by a human and therefore fallible: it depends on an env var
 * reaching the process and on a file having been written first. Measured on this machine, it failed
 * anyway — 1,175 entries carried the wrong name AFTER the persisted id existed, across 239 separate
 * sessions, and every hypothesis for which process produced them was checked and disproved. That is
 * the point: a name you cannot verify is a name you cannot debug.
 *
 * This is the answer to "which computer wrote this line?" independent of the name. It reads the
 * hardware/OS identity (macOS `IOPlatformUUID`, Linux `/etc/machine-id`), hashes it so nothing
 * identifying leaves the machine, and caches the result in the data dir. On failure it falls back to
 * a random id persisted once — still stable for that install, which is all the field promises.
 *
 * Twelve hex characters: enough that a collision across a personal fleet is not a real concern, short
 * enough to read in a log line.
 */
let machineIdCache: string | null = null;

export function machineId(): string {
  if (machineIdCache) return machineIdCache;
  const dir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  const idPath = join(dir, "machine-id");

  try {
    const cached = readFileSync(idPath, "utf-8").trim();
    if (cached) return (machineIdCache = cached);
  } catch { /* not derived yet */ }

  let raw = "";
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf-8", timeout: 5000,
      });
      raw = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? "";
    } else {
      for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try { raw = readFileSync(p, "utf-8").trim(); if (raw) break; } catch { /* next */ }
      }
    }
  } catch { /* fall through to the random id */ }

  // Hashed, never raw: the UUID identifies the hardware, and this field rides an anonymous channel.
  const id = raw
    ? createHash("sha256").update(raw).digest("hex").slice(0, 12)
    : randomUUID().replace(/-/g, "").slice(0, 12);

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(idPath, id, "utf-8");
  } catch { /* read-only data dir — still stable for this process */ }

  return (machineIdCache = id);
}

/** Test-only — drop the memoised value. */
export function _resetMachineIdForTests(): void {
  machineIdCache = null;
}

export function resolveHostTag(): string {
  const explicit = process.env["CODESIFT_HOST_TAG"]?.trim();
  // Seed the persisted id FROM the explicit tag when there is one. The whole
  // failure mode here is that the tag reaches some processes and not others (a
  // GUI app launched before `launchctl setenv` never sees it), so persisting it
  // the first time we DO see it is what makes the pin durable for the rest.
  if (explicit) return loadOrCreateStableHostId(explicit, { preferSeed: true });
  return loadOrCreateStableHostId(hostname());
}

/**
 * Read (or seed once) `<dataDir>/host-id`. Best-effort: any filesystem problem
 * falls back to the live hostname, which is what the old code always used.
 */
function loadOrCreateStableHostId(
  seed: string,
  opts?: { preferSeed?: boolean },
): string {
  const dir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  const idPath = join(dir, "host-id");

  let existing = "";
  try {
    existing = readFileSync(idPath, "utf-8").trim();
  } catch { /* not seeded yet */ }

  // An explicit CODESIFT_HOST_TAG is authoritative: adopt it and correct a file
  // that was seeded from a volatile hostname by some earlier env-less process.
  if (opts?.preferSeed) {
    if (existing !== seed) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(idPath, seed, "utf-8");
      } catch { /* read-only data dir — tag still applies to this process */ }
    }
    return seed;
  }

  if (existing) return existing;

  try {
    mkdirSync(dir, { recursive: true });
    // Freeze the current hostname so a later rename cannot split the machine.
    writeFileSync(idPath, seed, "utf-8");
  } catch { /* read-only data dir — use the volatile name for this process */ }
  return seed;
}

const HOST = resolveHostTag();
/**
 * Computed once, like HOST — but unlike HOST it cannot go stale, because it does not depend on an
 * env var arriving or a file being written first. A long-lived process that captured the wrong NAME
 * at startup (measured: 4 sessions wrote `Gregs-MacBook-Pro-M5-2.local` for four days) still stamps
 * the right MACHINE, so its entries remain attributable.
 */
const MACHINE = machineId();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Coarse failure classes. Deliberately few and deliberately about the CAUSE, not the tool: the
 * point is to answer "what kind of thing went wrong" from the log alone, which `error: true`
 * never could.
 */
export type ErrorClass =
  | "repo_not_indexed"      // the repo name/path resolved to nothing indexed
  | "path_outside_repos"    // an absolute path under no registered root (index_file's common case)
  | "file_missing"          // ENOENT — deleted or renamed between edit and index
  | "parse_failed"
  | "symbol_not_found"
  | "ambiguous_symbol_id"
  | "git_failed"            // git refused the ref/range — the worktree-vs-parent fault lives here
  | "plan_not_found"        // in-memory coordinator state, gone after a restart
  | "timeout"
  | "invalid_args"
  | "other";

/**
 * Map an error message to a class WITHOUT retaining the message.
 *
 * Ordered most-specific first: several of these messages overlap ("not found" appears in three
 * different faults that need different fixes), so a looser rule placed earlier would swallow the
 * precise ones and reintroduce exactly the ambiguity this exists to remove.
 */
export function classifyError(message: string): ErrorClass {
  const m = message;
  if (/^ENOENT|no such file or directory/i.test(m)) return "file_missing";
  if (/No indexed repo contains/i.test(m)) return "path_outside_repos";
  if (/Plan "[^"]*" not found/i.test(m)) return "plan_not_found";
  if (/Symbol "[^"]*" not found/i.test(m)) return "symbol_not_found";
  if (/ambiguous/i.test(m) && /id|symbol/i.test(m)) return "ambiguous_symbol_id";
  if (/Git .*failed|bad revision|unknown revision|not a git repository/i.test(m)) return "git_failed";
  if (/Failed to parse/i.test(m)) return "parse_failed";
  // Checked AFTER the specific "not found"s above, because this is the loose one.
  if (/Repository .*not found|not indexed|Run index_folder|Index it first/i.test(m)) {
    return "repo_not_indexed";
  }
  if (/timed? ?out|ETIMEDOUT|aborted due to timeout/i.test(m)) return "timeout";
  if (/is required|Invalid |must be |Expected /i.test(m)) return "invalid_args";
  return "other";
}

export interface UsageEntry {
  ts: number;
  /**
   * Stable machine identity — see {@link machineId}. Present so a line is attributable to a computer
   * even when `host` is wrong, which it demonstrably can be.
   */
  machine?: string;
  tool: string;
  repo: string;
  args_summary: Record<string, unknown>;
  elapsed_ms: number;
  /** Estimated tokens of the RAW handler result (pre-shortening). */
  result_tokens: number;
  result_chunks: number;
  session_id: string;
  /** Machine that produced the entry (os.hostname() or CODESIFT_HOST_TAG).
   * Lets stats split local vs remote once logs are merged. Absent in
   * pre-multi-host entries — readers treat those as the local host. */
  host?: string;
  /** Estimated tokens actually sent after the progressive-shortening
   * cascade + response hints. Present only when it differs from
   * result_tokens — so cascade effectiveness is measurable. */
  result_tokens_sent?: number;
  /** True when the handler threw — the logged result is the error message. */
  error?: boolean;
  /**
   * Coarse CLASS of that failure. The message itself is deliberately NOT stored: it carries
   * absolute paths, repo names and symbol names. The class carries none of that and is the one
   * thing that made every past error investigation expensive — `error: true` says a call failed
   * and nothing else, so diagnosing one meant reconstructing the cause from `repo`,
   * `args_summary` and `elapsed_ms`, none of which name it. Local file only: the L1 telemetry
   * payload is built by naming each field explicitly in `telemetry/aggregator.ts`, so this cannot
   * reach the collector without a deliberate change there (and to the first-run notice).
   */
  error_class?: ErrorClass;
  /** True when served from the response cache — excluded from latency/error/empty
   *  aggregation, counted only toward cache_hit_rate. */
  cache_hit?: boolean;
  /** Response-hint codes emitted on this call (e.g. ["H1","H12"]) — powers the
   *  hint-efficacy funnel. Codes only, never the hint text. */
  hints_emitted?: string[];
  /** Tool names plan_turn recommended on this call — powers the discovery funnel
   *  (was a recommended tool actually used next?). Names only. */
  recommended_tools?: string[];
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

export function getUsagePath(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, "usage.jsonl");
}

/**
 * Directory holding usage logs synced from other machines (one .jsonl per
 * host, e.g. usage-remote/vps.jsonl pulled via rsync/cron). Stats readers
 * merge these with the local log; the filename stem doubles as the host tag
 * for pre-multi-host entries that lack a `host` field.
 */
export function getRemoteUsageDir(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, "usage-remote");
}

/** Host tag stamped on entries written by this process. */
export function getLocalHostTag(): string {
  return HOST;
}

// ---------------------------------------------------------------------------
// Args summary builders — lightweight, never includes large content
// ---------------------------------------------------------------------------

/** Per-tool field extraction schema: [key, expectedType] pairs.
 * Exported for testing — assert a tool is absent to confirm telemetry blacklisting. */
export const TOOL_ARG_FIELDS: Record<string, Array<[string, "string" | "number" | "boolean"]>> = {
  search_symbols: [["kind", "string"], ["top_k", "number"], ["file_pattern", "string"], ["decorator", "string"], ["include_source", "boolean"]],
  search_text: [["regex", "boolean"], ["context_lines", "number"], ["file_pattern", "string"], ["max_results", "number"], ["group_by_file", "boolean"], ["auto_group", "boolean"], ["ranked", "boolean"], ["compact", "boolean"]],
  get_file_tree: [["path_prefix", "string"], ["name_pattern", "string"], ["depth", "number"]],
  get_file_outline: [["file_path", "string"]],
  get_symbol: [["symbol_id", "string"]],
  find_and_show: [["include_refs", "boolean"]],
  find_references: [["symbol_name", "string"], ["file_pattern", "string"]],
  trace_call_chain: [["symbol_name", "string"], ["direction", "string"], ["depth", "number"]],
  impact_analysis: [["since", "string"], ["until", "string"], ["depth", "number"]],
  assemble_context: [["token_budget", "number"]],
  get_knowledge_map: [["focus", "string"], ["depth", "number"]],
  diff_outline: [["since", "string"], ["until", "string"]],
  changed_symbols: [["since", "string"], ["until", "string"]],
  resolve_constant_value: [["symbol_name", "string"], ["file_pattern", "string"], ["max_depth", "number"]],
  effective_django_view_security: [["path", "string"], ["symbol_name", "string"], ["file_pattern", "string"], ["settings_file", "string"]],
  taint_trace: [["framework", "string"], ["file_pattern", "string"], ["max_depth", "number"], ["max_traces", "number"]],
  index_folder: [["path", "string"], ["incremental", "boolean"]],
  index_repo: [["url", "string"], ["branch", "string"]],
  generate_claude_md: [["output_path", "string"]],
  scan_secrets: [["file_pattern", "string"], ["min_confidence", "string"], ["severity", "string"], ["exclude_tests", "boolean"]],
};

/**
 * Build a lightweight args summary for a given tool call.
 * Extracts only the small, useful fields — never full source or query results.
 */
export function buildArgsSummary(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  // Common fields — always include if present
  if (typeof args["query"] === "string") summary["query"] = (args["query"] as string).slice(0, 200);
  if (typeof args["repo"] === "string") summary["repo"] = args["repo"];

  // Special cases with non-trivial extraction
  if (tool === "index_file") {
    // The argument that FAILS is the one worth logging. index_file takes only `path`, and the
    // summary carried `repo` (injected, cwd-derived, ignored by the handler) and not `path` — so
    // an errored row named neither the file nor its repo. Local file only: args_summary is not
    // part of the anonymous payload.
    if (typeof args["path"] === "string") summary["path"] = args["path"];
  } else if (tool === "codebase_retrieval") {
    const queries = args["queries"];
    if (Array.isArray(queries)) {
      summary["query_count"] = queries.length;
      summary["query_types"] = queries.map(
        (q: unknown) => (typeof q === "object" && q !== null ? (q as Record<string, unknown>)["type"] : "unknown"),
      );
    }
    if (typeof args["token_budget"] === "number") summary["token_budget"] = args["token_budget"];
  } else if (tool === "get_symbols") {
    const ids = args["symbol_ids"];
    if (Array.isArray(ids)) summary["symbol_count"] = ids.length;
  } else if (tool === "describe_tools") {
    // Capture which tool schemas were requested — previously logged as {} , which
    // hid repeat-fetch volume (920 calls / 1.8M tokens with no visibility into
    // whether the same schemas were re-requested and could be cached).
    const names = args["names"];
    if (Array.isArray(names)) {
      summary["names"] = names.filter((n) => typeof n === "string").slice(0, 30);
      summary["name_count"] = names.length;
    }
    if (typeof args["reveal"] === "boolean") summary["reveal"] = args["reveal"];
  }

  // Data-driven extraction for all standard tools
  const fields = TOOL_ARG_FIELDS[tool];
  if (fields) {
    for (const [key, type] of fields) {
      if (typeof args[key] === type) summary[key] = args[key];
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Result metrics extraction
// ---------------------------------------------------------------------------

/**
 * Estimate the number of discrete result items (chunks, symbols, files, etc.)
 * from the tool result object.
 */
/** Common "nothing found" markers in formatted string results. */
const NO_RESULT_STRING_RX = /^\(?no (results|matches|symbols|references|files)/i;

/** The repo this call was really about: the argument when given, otherwise the handler's answer. */
function resolveLoggedRepo(args: Record<string, unknown>, resultData: unknown): string {
  const fromArgs = args["repo"];
  if (typeof fromArgs === "string" && fromArgs.length > 0) return fromArgs;
  if (resultData && typeof resultData === "object") {
    const fromResult = (resultData as { repo?: unknown }).repo;
    if (typeof fromResult === "string" && fromResult.length > 0) return fromResult;
  }
  return "";
}

export function extractResultChunks(data: unknown): number {
  if (Array.isArray(data)) return data.length;

  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;

    // codebase_retrieval → results array
    if (Array.isArray(obj["results"])) return obj["results"].length;

    // various tools returning arrays under common keys
    if (Array.isArray(obj["symbols"])) return obj["symbols"].length;
    if (Array.isArray(obj["files"])) return obj["files"].length;
    if (Array.isArray(obj["matches"])) return obj["matches"].length;
    if (Array.isArray(obj["references"])) return obj["references"].length;
    // find_references' BATCH path returns `references` as a Record<name, Reference[]>, not an
    // array — so the Array.isArray branch above missed it and every batch call fell through to
    // `return 0`. That did not read as "the extractor missed a shape", it read as "the tool
    // found nothing": 922 of 1,216 successful calls logged result_chunks=0 while carrying a
    // MEDIAN of 2,076 result tokens, against 232 for the calls counted as non-empty. The
    // derived empty_result_rate — which ships in the L1 telemetry payload — therefore reported
    // ~76% misses for the tool's busiest path, all of them fictional.
    const refs = obj["references"];
    if (typeof refs === "object" && refs !== null) {
      let total = 0;
      for (const value of Object.values(refs as Record<string, unknown>)) {
        if (Array.isArray(value)) total += value.length;
      }
      return total;
    }
    if (Array.isArray(obj["repos"])) return obj["repos"].length;

    // single item results
    if (typeof obj["id"] === "string") return 1;
  }

  // Formatted-string results (most handlers return strings): non-empty line
  // count is a serviceable item proxy for tabular output, and lets telemetry
  // distinguish zero-result calls — previously every string-returning tool
  // logged result_chunks=0, making miss rates unmeasurable.
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (trimmed === "" || NO_RESULT_STRING_RX.test(trimmed)) return 0;
    return trimmed.split("\n").filter((l) => l.trim() !== "").length;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Core tracking function
// ---------------------------------------------------------------------------

let cumulativeTokensSaved = 0;

export function getCumulativeSavings(): number {
  return cumulativeTokensSaved;
}

export function addSavings(tokens: number): void {
  cumulativeTokensSaved += tokens;
}

let dirEnsured = false;

/**
 * Log a usage entry to ~/.codesift/usage.jsonl.
 * Non-blocking: errors are silently caught and logged to stderr.
 */
export async function trackUsage(entry: UsageEntry): Promise<void> {
  try {
    const usagePath = getUsagePath();

    if (!dirEnsured) {
      const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
      await mkdir(dataDir, { recursive: true });
      dirEnsured = true;
    }

    const line = JSON.stringify(entry) + "\n";
    await appendFile(usagePath, line, "utf-8");
  } catch (err: unknown) {
    // Never throw — tracking is best-effort
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[usage-tracker] Failed to log usage: ${message}`);
  }
}

/**
 * Recommendations stashed by the plan_turn handler. Needed because that handler
 * returns a FORMATTED STRING (formatPlanTurnResult), so the structured
 * PlanTurnResult never reaches trackToolCall — which silently produced an empty
 * discovery funnel (telemetry 2026-07-20: 1821 plan_turn calls, 0 recommendations
 * recorded). Set immediately before the handler returns; consumed by the very
 * next trackToolCall in the same tool-call flow.
 */
let pendingPlanTurnRecommendations: string[] = [];

export function setPlanTurnRecommendations(names: string[]): void {
  pendingPlanTurnRecommendations = names.filter((n) => typeof n === "string" && n).slice(0, 10);
}

function takePlanTurnRecommendations(): string[] {
  const out = pendingPlanTurnRecommendations;
  pendingPlanTurnRecommendations = [];
  return out;
}

/** Extract recommended tool names from a plan_turn result (names only, capped). */
function extractRecommendedTools(resultData: unknown): string[] {
  if (!resultData || typeof resultData !== "object") return [];
  const tools = (resultData as Record<string, unknown>)["tools"];
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const t of tools) {
    if (t && typeof t === "object") {
      const n = (t as Record<string, unknown>)["tool"] ?? (t as Record<string, unknown>)["name"];
      if (typeof n === "string" && n) names.push(n);
    }
  }
  return names.slice(0, 10);
}

/**
 * High-level helper: track a completed tool call.
 * Called at the end of each tool handler after the result is computed.
 */
export function trackToolCall(
  tool: string,
  args: Record<string, unknown>,
  resultText: string,
  resultData: unknown,
  elapsedMs: number,
  extra?: {
    /** Char length of the response actually sent (post-cascade, with hints). */
    sentChars?: number;
    /** The handler threw — resultText is the error message. */
    error?: boolean;
    /** Served from the response cache (excluded from latency/error/empty stats). */
    cacheHit?: boolean;
    /** Response-hint codes emitted on this call, e.g. ["H1","H12"]. */
    hintsEmitted?: string[];
  },
): void {
  const resultTokens = Math.ceil(resultText.length / 4);
  const sentTokens = extra?.sentChars !== undefined ? Math.ceil(extra.sentChars / 4) : undefined;
  // Prefer the handler-supplied names (the plan_turn handler returns a formatted
  // string); fall back to structured extraction if a caller returns raw data.
  const recommended =
    tool === "plan_turn"
      ? (() => {
          const stashed = takePlanTurnRecommendations();
          return stashed.length ? stashed : extractRecommendedTools(resultData);
        })()
      : [];
  const entry: UsageEntry = {
    ts: Date.now(),
    tool,
    // Prefer the caller's repo; fall back to the one the handler actually resolved. Tools that
    // take a PATH rather than a repo (index_file) know which repo it belonged to only after the
    // fact, and an empty string there makes their rows ungroupable — while an injected,
    // cwd-derived guess made them actively misleading.
    repo: resolveLoggedRepo(args, resultData),
    args_summary: buildArgsSummary(tool, args),
    elapsed_ms: Math.round(elapsedMs),
    result_tokens: resultTokens,
    result_chunks: extractResultChunks(resultData),
    session_id: SESSION_ID,
    host: HOST,
    machine: MACHINE,
    ...(sentTokens !== undefined && sentTokens !== resultTokens ? { result_tokens_sent: sentTokens } : {}),
    ...(extra?.error ? { error: true, error_class: classifyError(resultText) } : {}),
    ...(extra?.cacheHit ? { cache_hit: true } : {}),
    ...(extra?.hintsEmitted && extra.hintsEmitted.length ? { hints_emitted: extra.hintsEmitted } : {}),
    ...(recommended.length ? { recommended_tools: recommended } : {}),
  };

  // Fire and forget — never block the tool response
  trackUsage(entry).catch(() => {});
}

/**
 * Get the current session ID (for testing or display).
 */
export function getSessionId(): string {
  return SESSION_ID;
}
