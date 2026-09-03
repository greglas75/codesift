import { readVitals } from "../../server-helpers/health-vitals.js";

/**
 * Refuse to START materialising an index while the daemon cannot afford it.
 *
 * A cold `getCodeIndex` reads a whole index into memory — 349 MB and hundreds of thousands of
 * objects for the largest repo here — through a SYNCHRONOUS SQLite API. When the disk is saturated
 * (measured 2026-09-02: 50,835 IOPS at ~6.9 KB, the process in uninterruptible I/O) that read takes
 * minutes, and every other client waits behind it. The caller then hits its own timeout — 120 s in
 * both harnesses — and reports "CODESIFT UNAVAILABLE", so the session runs with NO tools at all.
 *
 * That is the worst possible outcome and it is entirely avoidable: BM25 and the resident caches are
 * usually still there and still answer in milliseconds. Losing semantic search is a degradation.
 * Losing the whole server is an outage, and the difference is which one the agent is told.
 *
 * So this guard is deliberately narrow. It gates ONLY a cold materialisation — an index already
 * resident is returned as normal, and every tool that does not need the full index is untouched. And
 * it fails FAST with a message naming the condition, because two seconds of "busy, retry" is worth
 * more to an agent than two minutes of silence followed by a timeout.
 */

/**
 * Event-loop lateness that means the thread is already oversubscribed. Below this a cold load is
 * merely slow; above it, it is slow AND holding up everyone else, which is the part that turns one
 * client's cold call into every client's outage.
 *
 * 2 s rather than something tighter: a lag of a few hundred milliseconds is ordinary during any
 * large read, and refusing there would make the guard fire during healthy operation — an index that
 * can never be loaded is worse than one that loads slowly.
 */
const LAG_REFUSE_MS = 2_000;

/** Approaching the ceiling, another 349 MB is what tips the process into an OOM restart, and a
 *  restart drops every in-flight call rather than just this one. */
const HEAP_REFUSE_PCT = 85;

export interface OverloadDecision {
  refuse: boolean;
  reason?: string;
}

export function assessOverload(vitals = readVitals()): OverloadDecision {
  if (vitals.event_loop_lag_ms >= LAG_REFUSE_MS) {
    return {
      refuse: true,
      reason:
        `the daemon's event loop is ${vitals.event_loop_lag_ms} ms behind — reading a whole index ` +
        `now would block every other client for minutes`,
    };
  }
  if (vitals.heap_used_pct >= HEAP_REFUSE_PCT) {
    return {
      refuse: true,
      reason:
        `heap is at ${vitals.heap_used_mb}/${vitals.heap_limit_mb} MB (${vitals.heap_used_pct}%) — ` +
        `loading another index risks an OOM restart, which drops every in-flight call`,
    };
  }
  return { refuse: false };
}

/**
 * Thrown instead of blocking. Structural detection (`isOverloadedError`) rather than `instanceof`,
 * for the same reason as AmbiguousSymbolIdError: a duplicated module instance across a worker or
 * bundler boundary breaks `instanceof` and would silently reclassify this as an unknown fault.
 */
export class DaemonOverloadedError extends Error {
  readonly overloaded = true;
  constructor(repoName: string, reason: string) {
    super(
      `CodeSift is busy: ${reason}. "${repoName}" is not resident, so this call would have to read ` +
        `it from disk. Nothing is broken and no retry is needed for tools that do not need the full ` +
        `index — text and symbol search, outlines and file trees still answer. Retry this one in a ` +
        `few seconds, or check /health (event_loop_lag_ms, heap_used_pct) to see when it clears.`,
    );
    this.name = "DaemonOverloadedError";
  }
}

export function isOverloadedError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { overloaded?: unknown }).overloaded === true;
}
