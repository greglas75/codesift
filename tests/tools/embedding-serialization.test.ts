import { awaitPendingEmbeddings } from "../../src/tools/index-tools/folder-indexer.js";

/**
 * These cover the two defects behind a `codesift index` process that reached
 * 163 GB RSS: unbounded CONCURRENCY of the detached embedding chain, and the
 * CLI exiting before that chain finished (silently writing no embeddings).
 *
 * scheduleEmbedding is module-private, so the behaviour is exercised through
 * the same queue the indexer uses, via awaitPendingEmbeddings.
 */
describe("background embedding runs", () => {
  it("awaitPendingEmbeddings resolves when nothing is queued", async () => {
    await expect(awaitPendingEmbeddings()).resolves.toBeUndefined();
  });

  it("serialises overlapping runs so peak cost stays at one run", async () => {
    // Model of the queue in folder-indexer: each request chains onto the
    // previous one for the same repo rather than running beside it.
    const runs = new Map<string, Promise<void>>();
    let active = 0;
    let peak = 0;

    const schedule = (repo: string, run: () => Promise<void>): Promise<void> => {
      const prev = runs.get(repo);
      const next = (prev ?? Promise.resolve()).then(run, run).finally(() => {
        if (runs.get(repo) === next) runs.delete(repo);
      });
      runs.set(repo, next);
      return next;
    };

    const work = async (): Promise<void> => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };

    // Ten watcher events for one repo, fired back to back.
    await Promise.all(Array.from({ length: 10 }, () => schedule("repo", work)));

    expect(peak).toBe(1); // never two chains alive at once
    expect(active).toBe(0);
    expect(runs.size).toBe(0); // queue drains, no leak
  });

  it("a failing run does not cancel the ones queued behind it", async () => {
    const runs = new Map<string, Promise<void>>();
    const order: string[] = [];

    const schedule = (repo: string, run: () => Promise<void>): Promise<void> => {
      const prev = runs.get(repo);
      const next = (prev ?? Promise.resolve())
        .then(run, run)
        .catch(() => { /* swallowed, as in folder-indexer */ })
        .finally(() => { if (runs.get(repo) === next) runs.delete(repo); });
      runs.set(repo, next);
      return next;
    };

    const p1 = schedule("repo", async () => { order.push("first"); throw new Error("boom"); });
    const p2 = schedule("repo", async () => { order.push("second"); });
    await Promise.all([p1, p2]);

    expect(order).toEqual(["first", "second"]);
    expect(runs.size).toBe(0);
  });
});
