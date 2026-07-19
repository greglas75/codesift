// Client-side aggregation: raw local usage entries → per-tool-per-day metrics.
// We send aggregates, never raw events (spec §3) — smaller payload, less leak
// surface. Only reads fields that already exist on UsageEntry.
import { readFile } from "node:fs/promises";
import type { UsageEntry } from "../usage-tracker.js";
import { getUsagePath } from "../usage-tracker.js";

export interface ToolAggregate {
  tool: string;
  day: string; // YYYY-MM-DD (UTC)
  count: number; // total invocations (executed + cache-served)
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  error_rate: number; // 0..1 over EXECUTED calls
  empty_result_rate: number; // 0..1 over executed calls (result_chunks === 0)
  cache_hit_rate: number; // 0..1 fraction served from the response cache
}

export interface HintEmission {
  day: string; // YYYY-MM-DD (UTC)
  hint_code: string; // "H1".."H18"
  emitted: number; // times emitted on a call that had a following call (checkable)
  applied: number; // subset where the next call followed the hint's advice
}

export interface PlanTurnFunnel {
  day: string;
  recommended: number; // plan_turn calls (with a following call) that recommended >=1 tool
  used: number; // subset where the next call used a recommended tool
}

function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Nearest-rank percentile over an already-sorted-ascending array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

interface Bucket {
  tool: string;
  day: string;
  latencies: number[];
  errors: number;
  empties: number;
  executed: number; // calls that actually ran (not cache-served)
  cacheHits: number;
}

/**
 * Pure aggregation over a set of usage entries. Groups by (tool, day) and
 * derives count, latency p50/p95/max, error_rate, empty_result_rate and
 * cache_hit_rate. Cache-served calls (`cache_hit === true`) are counted only
 * toward cache_hit_rate — never latency/error/empty (they didn't execute).
 * `empty_result_rate` uses result_chunks===0 — a query/path-free "did this
 * call find anything" signal already on the entry.
 */
export function aggregateToolMetrics(entries: UsageEntry[]): ToolAggregate[] {
  const buckets = new Map<string, Bucket>();

  for (const e of entries) {
    if (!e || typeof e.tool !== "string" || typeof e.ts !== "number") continue;
    const day = dayOf(e.ts);
    const key = `${e.tool}\0${day}`;
    let b = buckets.get(key);
    if (!b) {
      b = { tool: e.tool, day, latencies: [], errors: 0, empties: 0, executed: 0, cacheHits: 0 };
      buckets.set(key, b);
    }
    if (e.cache_hit === true) {
      b.cacheHits++;
      continue;
    }
    b.executed++;
    if (typeof e.elapsed_ms === "number" && Number.isFinite(e.elapsed_ms)) {
      b.latencies.push(e.elapsed_ms);
    }
    if (e.error === true) b.errors++;
    if (e.result_chunks === 0) b.empties++;
  }

  const out: ToolAggregate[] = [];
  for (const b of buckets.values()) {
    const sorted = b.latencies.slice().sort((a, c) => a - c);
    const total = b.executed + b.cacheHits;
    out.push({
      tool: b.tool,
      day: b.day,
      count: total,
      p50_ms: percentile(sorted, 0.5),
      p95_ms: percentile(sorted, 0.95),
      max_ms: sorted.length ? sorted[sorted.length - 1]! : 0,
      error_rate: b.executed ? round3(b.errors / b.executed) : 0,
      empty_result_rate: b.executed ? round3(b.empties / b.executed) : 0,
      cache_hit_rate: total ? round3(b.cacheHits / total) : 0,
    });
  }
  // Deterministic order (day desc, then tool) — stable payloads, easier diffing.
  out.sort((a, c) => (a.day === c.day ? a.tool.localeCompare(c.tool) : c.day.localeCompare(a.day)));
  return out;
}

/** Group entries into per-session chains sorted by ts, for next-call correlation. */
function sessionChains(entries: UsageEntry[]): UsageEntry[][] {
  const bySession = new Map<string, UsageEntry[]>();
  for (const e of entries) {
    if (!e || typeof e.ts !== "number") continue;
    const s = typeof e.session_id === "string" ? e.session_id : "?";
    (bySession.get(s) ?? bySession.set(s, []).get(s)!).push(e);
  }
  for (const chain of bySession.values()) chain.sort((a, b) => a.ts - b.ts);
  return [...bySession.values()];
}

const has = (e: UsageEntry, k: string): boolean =>
  e.args_summary != null && typeof e.args_summary === "object" && k in e.args_summary;

/** Did the follow-up call `n` act on hint `code`? Codes without a rule are
 *  counted as emitted but never applied (honest under-report). */
const HINT_APPLIED: Record<string, (n: UsageEntry) => boolean> = {
  H1: (n) => has(n, "group_by_file") && n.args_summary["group_by_file"] === true,
  H2: (n) => n.tool === "get_symbols" || n.tool === "codebase_retrieval",
  H3: (n) => n.tool !== "list_repos",
  H4: (n) => has(n, "file_pattern"),
  H5: (n) => n.tool !== "get_file_tree",
  H6: (n) => has(n, "detail_level"),
  H7: (n) => n.tool === "get_context_bundle",
  H8: (n) => n.tool === "assemble_context",
  H9: (n) => n.tool === "semantic_search" || n.tool === "codebase_retrieval",
  H10: (n) => n.tool === "get_session_snapshot",
  H12: (n) => n.tool === "codebase_retrieval",
};

/**
 * Hint efficacy funnel (spec §1): per (day, code), how often a hint was emitted
 * on a call that had a follow-up, and how often that follow-up actually acted on
 * it. Correlation is per session, in ts order, and reads only args_summary keys
 * locally — the wire payload carries just the counts.
 */
export function aggregateHintFunnel(entries: UsageEntry[]): HintEmission[] {
  const acc = new Map<string, { emitted: number; applied: number }>();
  for (const chain of sessionChains(entries)) {
    for (let i = 0; i < chain.length - 1; i++) {
      const e = chain[i]!;
      const next = chain[i + 1]!;
      if (!Array.isArray(e.hints_emitted)) continue;
      const day = dayOf(e.ts);
      for (const code of e.hints_emitted) {
        if (typeof code !== "string") continue;
        const key = `${day}\0${code}`;
        const a = acc.get(key) ?? { emitted: 0, applied: 0 };
        a.emitted++;
        if (HINT_APPLIED[code]?.(next)) a.applied++;
        acc.set(key, a);
      }
    }
  }
  const out: HintEmission[] = [];
  for (const [key, v] of acc) {
    const [day, code] = key.split("\0");
    out.push({ day: day!, hint_code: code!, emitted: v.emitted, applied: v.applied });
  }
  out.sort((a, c) => (a.day === c.day ? a.hint_code.localeCompare(c.hint_code) : c.day.localeCompare(a.day)));
  return out;
}

/**
 * Discovery funnel (spec §1): per day, how often plan_turn recommended >=1 tool
 * (on a call with a follow-up) and how often the next call used one of them —
 * i.e. is the router's advice actually taken?
 */
export function aggregatePlanTurnFunnel(entries: UsageEntry[]): PlanTurnFunnel[] {
  const acc = new Map<string, { recommended: number; used: number }>();
  for (const chain of sessionChains(entries)) {
    for (let i = 0; i < chain.length - 1; i++) {
      const e = chain[i]!;
      if (e.tool !== "plan_turn" || !Array.isArray(e.recommended_tools) || e.recommended_tools.length === 0) continue;
      const day = dayOf(e.ts);
      const a = acc.get(day) ?? { recommended: 0, used: 0 };
      a.recommended++;
      if (e.recommended_tools.includes(chain[i + 1]!.tool)) a.used++;
      acc.set(day, a);
    }
  }
  const out: PlanTurnFunnel[] = [];
  for (const [day, v] of acc) out.push({ day, recommended: v.recommended, used: v.used });
  out.sort((a, c) => c.day.localeCompare(a.day));
  return out;
}

/**
 * Read + parse the local usage.jsonl (best-effort — skips malformed lines).
 * `afterTs` is EXCLUSIVE (strictly greater) so it composes with an upload
 * watermark (the max ts already sent) without re-sending the boundary entry.
 */
export async function readLocalUsageEntries(afterTs = 0): Promise<UsageEntry[]> {
  let raw: string;
  try {
    raw = await readFile(getUsagePath(), "utf-8");
  } catch {
    return [];
  }
  const entries: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as UsageEntry;
      if (typeof e.ts === "number" && e.ts > afterTs) entries.push(e);
    } catch {
      /* skip torn/partial line */
    }
  }
  return entries;
}
