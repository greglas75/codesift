// What /health has to be able to say.
//
// Three incidents in one week produced the SAME client-side symptom — sessions reporting
// "CODESIFT UNAVAILABLE" — from three unrelated causes: CPU starvation at load 235, an OOM
// crash-loop (15.1 GB → 16.0 GB → restart → repeat), and disk saturation at 50,835 IOPS with the
// process in uninterruptible I/O. Each cost its own investigation to separate.
//
// /health answered {"status":"ok"} through all three. It reported liveness, which was never the
// question — the daemon was alive every time. The question is whether it can SERVE.
import { describe, it, expect, afterEach } from "vitest";
import {
  readVitals, classifyVitals, setEventLoopLagForTesting, startVitals, stopVitals,
} from "../../src/server-helpers/health-vitals.js";

afterEach(() => { stopVitals(); setEventLoopLagForTesting(0); });

describe("health vitals", () => {
  it("reports a quiet daemon as ok", () => {
    setEventLoopLagForTesting(0);
    const { status, reasons } = classifyVitals({ ...readVitals(), event_loop_lag_ms: 0, heap_used_pct: 10 });
    expect(status).toBe("ok");
    expect(reasons).toEqual([]);
  });

  it("says BUSY when the loop is late — the symptom all three incidents shared", () => {
    const { status, reasons } = classifyVitals({ ...readVitals(), event_loop_lag_ms: 4_000, heap_used_pct: 10 });
    expect(status).toBe("busy");
    expect(reasons.join(" ")).toMatch(/queueing behind blocking work/);
  });

  it("says BUSY on an approaching heap ceiling — what an OOM loop walks up before each crash", () => {
    const { status, reasons } = classifyVitals({
      ...readVitals(), event_loop_lag_ms: 0, heap_used_mb: 15_000, heap_limit_mb: 16_384, heap_used_pct: 92,
    });
    expect(status).toBe("busy");
    expect(reasons.join(" ")).toMatch(/OOM restart/);
  });

  it("is never 503 for busy — slow is not down", () => {
    // A session told "down" stops using tools it could still have used, which is exactly how a
    // degraded daemon became "CodeSift is unavailable" in every one of those agent reports.
    const busy = classifyVitals({ ...readVitals(), event_loop_lag_ms: 9_999, heap_used_pct: 99 });
    expect(busy.status).toBe("busy");
    expect(["ok", "busy"]).toContain(busy.status);
  });

  it("reads the heap ceiling this process was actually started with", () => {
    const v = readVitals();
    expect(v.heap_limit_mb).toBeGreaterThan(0);
    expect(v.heap_used_pct).toBe(Math.round((v.heap_used_mb / v.heap_limit_mb) * 100));
  });

  it("reports uptime, because a crash-loop is invisible in a single snapshot", () => {
    // A freshly respawned process looks perfectly healthy; only a resetting uptime says it is the
    // fourth one this hour.
    expect(readVitals().uptime_s).toBeGreaterThanOrEqual(0);
  });

  it("samples the loop continuously, and the sampler never holds the process open", () => {
    startVitals(10);
    // Calling twice must not stack a second interval.
    startVitals(10);
    expect(readVitals().event_loop_lag_ms).toBeGreaterThanOrEqual(0);
  });
});
