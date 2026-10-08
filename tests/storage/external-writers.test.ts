/**
 * A child process rewriting an index holds SQLite's write lock; this process's incremental writes
 * must queue behind it (an `await`) instead of spinning on busy_timeout inside a synchronous call,
 * and must land AFTER the child's commit so the child cannot overwrite them.
 */
import { describe, expect, it } from "vitest";
import { awaitExternalWriter, trackExternalWriter } from "../../src/storage/external-writers.js";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("external writers", () => {
  it("resolves immediately when nothing is writing", async () => {
    await expect(awaitExternalWriter("/no/such/index.json")).resolves.toBeUndefined();
  });

  it("waits for the writer to settle, and does not reject when it fails", async () => {
    const path = "/tmp/x.index.json";
    const child = deferred();
    trackExternalWriter(path, child.promise);
    const order: string[] = [];
    const waiting = awaitExternalWriter(path).then(() => order.push("write"));
    await Promise.resolve();
    order.push("child-commit");
    child.reject(new Error("child failed after commit"));
    await waiting;
    expect(order).toEqual(["child-commit", "write"]);
  });

  it("also waits for a writer registered while it was waiting", async () => {
    const path = "/tmp/y.index.json";
    const first = deferred();
    const second = deferred();
    trackExternalWriter(path, first.promise);
    let done = false;
    const waiting = awaitExternalWriter(path).then(() => { done = true; });
    trackExternalWriter(path, second.promise);
    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(done).toBe(false);
    second.resolve();
    await waiting;
    expect(done).toBe(true);
  });
});
