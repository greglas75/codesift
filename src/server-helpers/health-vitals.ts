import { totalmem } from "node:os";
import { memoryUsage } from "node:process";

/**
 * What `/health` has to be able to say.
 *
 * Three separate incidents in one week produced the SAME symptom at the client — sessions reporting
 * "CODESIFT UNAVAILABLE" — and had three unrelated causes: CPU starvation at load 235, an OOM
 * crash-loop (15.1 GB → 16.0 GB → restart → repeat), and disk saturation at 50,835 IOPS with the
 * process in uninterruptible I/O. Each took its own investigation to separate.
 *
 * `/health` answered `{"status":"ok"}` throughout all three. It reported liveness, which was never
 * the question: the daemon was alive every time. The question is whether it can SERVE, and the two
 * differ exactly when it matters.
 *
 * So this reports the quantities that actually moved, and nothing that did not:
 *
 *   - event-loop lag: the one number that captures "answering slowly" whatever the cause, because
 *     every one of the three ended with requests queued behind a blocked thread;
 *   - heap against the ceiling, which is what an OOM loop walks up before each crash and what no
 *     liveness check can see;
 *   - uptime, because a crash-loop is invisible in a snapshot — a fresh process looks healthy, and
 *     only a resetting uptime says it is the fourth one this hour.
 */
export interface Vitals {
  /** Milliseconds the event loop was late on a timer it should have run immediately. */
  event_loop_lag_ms: number;
  heap_used_mb: number;
  heap_limit_mb: number;
  heap_used_pct: number;
  rss_mb: number;
  uptime_s: number;
}

let lagMs = 0;
let timer: NodeJS.Timeout | null = null;

const SAMPLE_INTERVAL_MS = 500;

/**
 * Sample the loop's lateness continuously, because measuring it inside the request would measure a
 * loop that has, by definition, just reached our handler. The interesting value is how late the
 * loop was while nobody was asking.
 */
export function startVitals(intervalMs: number = SAMPLE_INTERVAL_MS): void {
  if (timer) return;
  let expected = Date.now() + intervalMs;
  timer = setInterval(() => {
    const now = Date.now();
    lagMs = Math.max(0, now - expected);
    expected = now + intervalMs;
  }, intervalMs);
  // Must never hold the process open: a daemon told to exit exits.
  timer.unref();
}

export function stopVitals(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  lagMs = 0;
}

/** Exported for tests, which cannot wait 500 ms per case. */
export function setEventLoopLagForTesting(ms: number): void {
  lagMs = ms;
}

function heapLimitMb(): number {
  // The ceiling this process was actually started with, not a guess: the LaunchAgent passes
  // --max-old-space-size, and reading it back is the only way the percentage below means anything.
  const flag = process.execArgv.find((a) => a.startsWith("--max-old-space-size="));
  const parsed = flag ? Number.parseInt(flag.split("=")[1] ?? "", 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  // No flag: V8's default is derived from system memory and is what the OOM crash-loop hit on this
  // machine (4288 MB on 128 GB of RAM). Approximating it is better than reporting a percentage of
  // nothing, and the value is only ever used to say "how close are we".
  return Math.min(4096, Math.max(2048, Math.round(totalmem() / 1024 ** 2 / 32)));
}

export function readVitals(): Vitals {
  const mem = memoryUsage();
  const limit = heapLimitMb();
  const usedMb = mem.heapUsed / 1024 ** 2;
  return {
    event_loop_lag_ms: Math.round(lagMs),
    heap_used_mb: Math.round(usedMb),
    heap_limit_mb: limit,
    heap_used_pct: Math.round((usedMb / limit) * 100),
    rss_mb: Math.round(mem.rss / 1024 ** 2),
    uptime_s: Math.round(process.uptime()),
  };
}

/**
 * Degraded is NOT the same as dead, and conflating them is what made every one of those incidents
 * look like "CodeSift is down" to an agent that could still have used it.
 *
 * `busy` keeps the 200: tool calls will be slow, the session should still load its tools and work.
 * Only `stale` — code replaced under a running process, where every call genuinely fails — is a 503.
 */
const LAG_BUSY_MS = 2_000;
const HEAP_BUSY_PCT = 85;

export function classifyVitals(v: Vitals): { status: "ok" | "busy"; reasons: string[] } {
  const reasons: string[] = [];
  if (v.event_loop_lag_ms >= LAG_BUSY_MS) {
    reasons.push(`event loop ${v.event_loop_lag_ms} ms late — requests are queueing behind blocking work`);
  }
  if (v.heap_used_pct >= HEAP_BUSY_PCT) {
    reasons.push(`heap ${v.heap_used_mb}/${v.heap_limit_mb} MB (${v.heap_used_pct}%) — an OOM restart drops every in-flight call`);
  }
  return reasons.length > 0 ? { status: "busy", reasons } : { status: "ok", reasons };
}
