import type { CheckRun } from "./types.js";
import { withTimeout } from "../review-diff/timeout.js";

export const AUDIT_TIMEOUT = 10000;

/** Run one check with a timeout and capture its duration/error without aborting peers. */
export async function runCheck<T>(name: string, fn: () => Promise<T>): Promise<CheckRun<T>> {
  const start = Date.now();
  try {
    const result = await withTimeout(fn(), AUDIT_TIMEOUT);
    if (typeof result === "object" && result !== null && "status" in result && result.status === "timeout") {
      return { name, result: "TIMEOUT", ms: Date.now() - start };
    }
    return { name, result: result as T, ms: Date.now() - start };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, result: "ERROR", ms: Date.now() - start, error: msg };
  }
}
