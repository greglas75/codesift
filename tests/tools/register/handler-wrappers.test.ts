import { describe, it, expect, vi, afterEach } from "vitest";
import {
  withTimeout,
  withCache,
  stableStringify,
} from "../../../src/register-tool-groups/handler-wrappers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("(a) times out a slow handler, swallows the late rejection, passes fast through", async () => {
    // Track any unhandled rejections that escape the wrapper.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      if (reason instanceof Error && reason.message === "late boom") {
        unhandled.push(reason);
      }
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      vi.useFakeTimers();

      // Handler that never settles on its own; we capture its reject fn.
      let rejectSlow!: (e: unknown) => void;
      const slow = (): Promise<string> =>
        new Promise<string>((_res, rej) => {
          rejectSlow = rej;
        });

      const wrapped = withTimeout(slow, 20, "slow_tool");
      const promise = wrapped();

      await vi.advanceTimersByTimeAsync(25);
      const result = await promise;
      expect(result).toEqual({ status: "timed_out", tool: "slow_tool" });

      // A fast handler passes its value through unchanged.
      const fast = withTimeout(async () => 42, 20);
      await expect(fast()).resolves.toBe(42);

      // The abandoned slow handler settles (rejects) AFTER the timeout.
      vi.useRealTimers();
      rejectSlow(new Error("late boom"));

      // Give Node a real tick to surface any unhandledRejection.
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("omits the tool field when no tool name is given", async () => {
    vi.useFakeTimers();
    const never = (): Promise<number> => new Promise<number>(() => {});
    const promise = withTimeout(never, 10)();
    await vi.advanceTimersByTimeAsync(15);
    await expect(promise).resolves.toEqual({ status: "timed_out" });
  });
});

describe("withCache", () => {
  it("(b) caches by key; hit skips the underlying handler; changed key/version misses", async () => {
    const spy = vi.fn(async (args: { id: number }) => ({ value: args.id * 10 }));
    let indexVersion = 1;
    const keyFn = (args: { id: number }): string =>
      `${indexVersion}|${stableStringify(args)}`;
    const cached = withCache(spy, keyFn);

    const r1 = await cached({ id: 1 });
    const r2 = await cached({ id: 1 });
    expect(r1).toEqual({ value: 10 });
    expect(r2).toBe(r1); // same cached reference
    expect(spy).toHaveBeenCalledTimes(1);

    // Different key (different args) → miss.
    await cached({ id: 2 });
    expect(spy).toHaveBeenCalledTimes(2);

    // Bumped index-version component in the key → same args now miss.
    indexVersion = 2;
    await cached({ id: 1 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("(c) coalesces concurrent same-key calls into a single execution", async () => {
    let resolveInner!: (v: { value: number }) => void;
    const spy = vi.fn(
      (_args: { id: number }) =>
        new Promise<{ value: number }>((res) => {
          resolveInner = res;
        }),
    );
    const cached = withCache(spy, (args: { id: number }) => stableStringify(args));

    const p1 = cached({ id: 1 });
    const p2 = cached({ id: 1 }); // started before p1 resolves
    expect(spy).toHaveBeenCalledTimes(1);

    resolveInner({ value: 99 });
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toEqual({ value: 99 });
    expect(b).toBe(a);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not cache rejections (failures are retried, not sticky)", async () => {
    let attempt = 0;
    const spy = vi.fn(async (_args: { id: number }) => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return { ok: true };
    });
    const cached = withCache(spy, (args: { id: number }) => stableStringify(args));

    await expect(cached({ id: 1 })).rejects.toThrow("boom");
    // Second call with same key must re-invoke since the failure was not cached.
    await expect(cached({ id: 1 })).resolves.toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("(d) shouldCache=false evicts resolved-but-uncacheable results (retried, not sticky)", async () => {
    let attempt = 0;
    const spy = vi.fn(async (_args: { id: number }) => {
      attempt += 1;
      // First call RESOLVES an error (not a rejection); second resolves success.
      return attempt === 1 ? { isError: true } : { ok: true };
    });
    const cached = withCache(
      spy,
      (args: { id: number }) => stableStringify(args),
      256,
      (res: { isError?: boolean }) => res.isError !== true,
    );

    const first = await cached({ id: 1 });
    expect(first).toEqual({ isError: true });
    // Same key → NOT served from cache because the resolved error was evicted.
    const second = await cached({ id: 1 });
    expect(second).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("(e) shouldCache=true retains a successful result (served from cache on hit)", async () => {
    const spy = vi.fn(async (args: { id: number }) => ({ value: args.id, isError: false }));
    const cached = withCache(
      spy,
      (args: { id: number }) => stableStringify(args),
      256,
      (res: { isError?: boolean }) => res.isError !== true,
    );

    const r1 = await cached({ id: 1 });
    const r2 = await cached({ id: 1 });
    expect(r2).toBe(r1); // same cached reference
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // A null key means "this call is not cacheable" — used when the caller cannot
  // observe a version for the repo. Memoizing under a key with no version component
  // would pin the entry for the life of the process ("unknown version = cache
  // forever"), so such a call must never be memoized.
  it("(f) keyFn returning null bypasses the cache entirely (never memoized)", async () => {
    const spy = vi.fn(async (args: { id: number }) => ({ value: args.id }));
    const cached = withCache(spy, (args: { id: number }) => (args.id === 0 ? null : `k${args.id}`));

    await cached({ id: 0 });
    await cached({ id: 0 });
    expect(spy).toHaveBeenCalledTimes(2); // re-invoked — nothing memoized
    expect(cached.has({ id: 0 })).toBe(false);
    expect(() => cached.evict({ id: 0 })).not.toThrow(); // no-op, not a crash

    // A keyable call still memoizes.
    await cached({ id: 1 });
    await cached({ id: 1 });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(cached.has({ id: 1 })).toBe(true);
  });

  // An entry is inserted BEFORE the handler settles. A handler that NEVER settles
  // would otherwise pin its dead promise forever and every later identical call
  // would join it — the key bricked for the process's life. `evict` is the escape
  // hatch the timeout owner uses; `has` lets the caller tell a hit from a miss (on a
  // hit the handler never runs, so only the caller can emit hit telemetry).
  it("(g) has() reports hits and evict() frees a key pinned by a never-settling handler", async () => {
    let calls = 0;
    const handler = (args: { id: number }): Promise<string> => {
      calls += 1;
      if (calls === 1) return new Promise<string>(() => {}); // never settles
      return Promise.resolve(`ok${args.id}`);
    };
    const cached = withCache(handler, (args: { id: number }) => `k${args.id}`);

    expect(cached.has({ id: 1 })).toBe(false); // cold
    void cached({ id: 1 });                    // in-flight, never settles
    expect(cached.has({ id: 1 })).toBe(true);  // a 2nd call would join the dead promise
    expect(calls).toBe(1);

    cached.evict({ id: 1 });
    expect(cached.has({ id: 1 })).toBe(false);

    await expect(cached({ id: 1 })).resolves.toBe("ok1"); // re-invoked, not bricked
    expect(calls).toBe(2);
    expect(cached.has({ id: 1 })).toBe(true); // the good result is memoized
  });
});

describe("stableStringify", () => {
  it("produces order-independent output for object keys (including nested)", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ x: { p: 1, q: 2 } })).toBe(
      stableStringify({ x: { q: 2, p: 1 } }),
    );
  });
});
