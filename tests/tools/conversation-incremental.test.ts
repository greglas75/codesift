// Conversation indexing had no change detection of any kind: every call re-read every `.jsonl`,
// re-extracted every turn and rebuilt the BM25 index. `autoDiscoverConversations` runs it on server
// start, and the largest conversation directory on this machine is 160,626 turns / 72 MB of source
// whose BM25 build alone measures 35.8 s — paid on every spawn, for a directory that usually gained
// one session or nothing.
//
// It was also what made persisting the index pointless: `persistConversationIndex` stamps
// `updated_at: Date.now()`, so an unconditional rescan invalidated its own cache every time. The two
// have to land together, which is why they are tested together here.
//
// The reason it could not be fixed by comparison alone: `FileEntry.last_modified` was set to
// `Date.now()` — when the scanner ran, not when the file changed — so a stored index could never be
// shown to be current against anything on disk.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, utimes, unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let dataDir: string;
let prevDataDir: string | undefined;

function session(id: string, turns: number): string {
  const lines: string[] = [];
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({
      type: "user", message: { content: `question ${i} about retention and budgets` },
      uuid: `u${id}-${i}`, sessionId: id, timestamp: "2026-09-27T10:00:00Z",
    }));
    lines.push(JSON.stringify({
      type: "assistant", message: { content: [{ type: "text", text: `answer ${i}` }] },
      uuid: `a${id}-${i}`, sessionId: id,
    }));
  }
  return lines.join("\n");
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "conv-incr-"));
  dataDir = await mkdtemp(join(tmpdir(), "codesift-data-"));
  prevDataDir = process.env["CODESIFT_DATA_DIR"];
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  const { resetConfigCache } = await import("../../src/config.js");
  resetConfigCache();
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = prevDataDir;
  const { resetConfigCache } = await import("../../src/config.js");
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("conversation indexing — change detection", () => {
  it("records the file's mtime, not the time the scan ran", async () => {
    // The whole comparison rests on this field. `Date.now()` here is why there was no skip to write.
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    await writeFile(join(tmpDir, "s1.jsonl"), session("s1", 3));
    const onDisk = statSync(join(tmpDir, "s1.jsonl")).mtimeMs;

    await indexConversations(tmpDir, { embed: false });

    const { loadIndexSummary, getIndexPath } = await import("../../src/storage/index-store.js");
    const { loadConfig } = await import("../../src/config.js");
    const summary = await loadIndexSummary(getIndexPath(loadConfig().dataDir, tmpDir));
    expect(summary?.files).toHaveLength(1);
    expect(summary!.files[0]!.mtime_ms).toBe(onDisk);
    expect(summary!.files[0]!.last_modified).toBe(onDisk);
  });

  it("skips a second pass over an unchanged directory", async () => {
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    await writeFile(join(tmpDir, "s1.jsonl"), session("s1", 3));
    const first = await indexConversations(tmpDir, { embed: false });
    expect(first.unchanged).toBeUndefined();

    const second = await indexConversations(tmpDir, { embed: false });
    expect(second.unchanged).toBe(true);
    // The counts still have to be right — a skip that reports nothing is a skip nobody can trust.
    expect(second.sessions_found).toBe(first.sessions_found);
    expect(second.turns_indexed).toBe(first.turns_indexed);
  });

  it("counts turns, not symbols, on an incremental pass", async () => {
    // A compacted session carries one `conversation_summary` symbol on top of its turns, so reporting
    // the symbol count over-reported by exactly the compacted count — 15,894 against a scanned pass's
    // 15,887 on this machine, with 7 compacted sessions.
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    for (const id of ["s1", "s2", "s3", "s4"]) {
      await writeFile(join(tmpDir, `${id}.jsonl`), session(id, 2));
    }
    await writeFile(join(tmpDir, "s3.jsonl"), [
      session("s3", 2),
      JSON.stringify({
        type: "user", isCompactSummary: true,
        message: { content: "earlier turns were compacted away" },
        uuid: "u-sum", sessionId: "s3", timestamp: "2026-09-27T09:00:00Z",
      }),
    ].join("\n"));
    const full = await indexConversations(tmpDir, { embed: false });

    await writeFile(join(tmpDir, "s1.jsonl"), session("s1", 2));
    const later = new Date(Date.now() + 5_000);
    await utimes(join(tmpDir, "s1.jsonl"), later, later);
    const incr = await indexConversations(tmpDir, { embed: false });
    expect(incr.incremental).toBe(true);
    // Same content, so the same turn count a scanned pass reported — not that plus the summary.
    expect(incr.turns_indexed).toBe(full.turns_indexed);
    expect(incr.compacted_sessions).toBe(full.compacted_sessions);
  });

  it("rescans when a session gains a turn", async () => {
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    const path = join(tmpDir, "s1.jsonl");
    await writeFile(path, session("s1", 2));
    const first = await indexConversations(tmpDir, { embed: false });

    await writeFile(path, session("s1", 5));
    const second = await indexConversations(tmpDir, { embed: false });
    expect(second.unchanged).toBeUndefined();
    expect(second.turns_indexed).toBeGreaterThan(first.turns_indexed);
  });

  it("rescans when a session is added, and when one is removed", async () => {
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    await writeFile(join(tmpDir, "s1.jsonl"), session("s1", 2));
    await indexConversations(tmpDir, { embed: false });

    await writeFile(join(tmpDir, "s2.jsonl"), session("s2", 2));
    expect((await indexConversations(tmpDir, { embed: false })).unchanged).toBeUndefined();
    expect((await indexConversations(tmpDir, { embed: false })).unchanged).toBe(true);

    await unlink(join(tmpDir, "s2.jsonl"));
    expect((await indexConversations(tmpDir, { embed: false })).unchanged).toBeUndefined();
  });

  it("rescans when a file is rewritten with the same length but a newer mtime", async () => {
    // A path set and a count both match here, so only the mtime distinguishes them.
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    const path = join(tmpDir, "s1.jsonl");
    await writeFile(path, session("s1", 2));
    await indexConversations(tmpDir, { embed: false });

    const later = new Date(Date.now() + 5_000);
    await utimes(path, later, later);
    expect((await indexConversations(tmpDir, { embed: false })).unchanged).toBeUndefined();
  });
});

describe("conversation indexing — incremental update", () => {
  it("re-extracts only the session that changed", async () => {
    // The skip covers a directory nothing touched, which is every project except the one being worked
    // in. The ACTIVE project's directory changes on every turn, so for it the skip can never fire, and
    // a full pass over the largest one here measures 156 s for 211 sessions / 164,500 turns — paid on
    // every server spawn.
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    for (const id of ["s1", "s2", "s3", "s4"]) {
      await writeFile(join(tmpDir, `${id}.jsonl`), session(id, 3));
    }
    const first = await indexConversations(tmpDir, { embed: false });
    expect(first.incremental).toBeUndefined();

    await writeFile(join(tmpDir, "s2.jsonl"), session("s2", 6));
    const second = await indexConversations(tmpDir, { embed: false });
    expect(second.incremental).toBe(true);
    expect(second.changed_sessions).toBe(1);
    expect(second.sessions_found).toBe(4);
    expect(second.turns_indexed).toBeGreaterThan(first.turns_indexed);
  });

  it("the amended index is searchable for both new and untouched sessions", async () => {
    // `updateBM25ForFile` mutates the loaded index in place. If it removed the wrong file's postings
    // the result is a well-formed index that silently lost a session.
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    const { searchConversations } = await import("../../src/tools/conversation-search-tools.js");
    await writeFile(join(tmpDir, "s1.jsonl"), session("s1", 3));
    await writeFile(join(tmpDir, "s2.jsonl"), session("s2", 3));
    await writeFile(join(tmpDir, "s3.jsonl"), session("s3", 3));
    await writeFile(join(tmpDir, "s4.jsonl"), session("s4", 3));
    await indexConversations(tmpDir, { embed: false });

    await writeFile(join(tmpDir, "s2.jsonl"), [
      session("s2", 3),
      JSON.stringify({ type: "user", message: { content: "an entirely fresh question about nftables" },
        uuid: "u-nf", sessionId: "s2", timestamp: "2026-09-27T12:00:00Z" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "use iifname" }] },
        uuid: "a-nf", sessionId: "s2" }),
    ].join("\n"));
    const r = await indexConversations(tmpDir, { embed: false });
    expect(r.incremental).toBe(true);

    const added = await searchConversations("nftables", tmpDir, 20);
    expect(added.results.length).toBeGreaterThan(0);
    // An untouched session must still be there — this is what a wrong-file removal would break.
    const untouched = await searchConversations("retention and budgets", tmpDir, 50);
    const files = new Set(untouched.results.map((x) => x.file));
    expect(files.has("s4.jsonl")).toBe(true);
  });

  it("drops a deleted session's turns from the amended index", async () => {
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    const { searchConversations } = await import("../../src/tools/conversation-search-tools.js");
    for (const id of ["s1", "s2", "s3", "s4"]) {
      await writeFile(join(tmpDir, `${id}.jsonl`), session(id, 3));
    }
    await indexConversations(tmpDir, { embed: false });

    await unlink(join(tmpDir, "s2.jsonl"));
    const r = await indexConversations(tmpDir, { embed: false });
    expect(r.incremental).toBe(true);
    expect(r.sessions_found).toBe(3);

    const after = await searchConversations("retention and budgets", tmpDir, 50);
    expect(new Set(after.results.map((x) => x.file)).has("s2.jsonl")).toBe(false);
  });

  it("reports compacted_sessions on an incremental pass instead of a silent zero", async () => {
    // It used to return 0 because the count is not stored. A 0 there is indistinguishable from
    // "scanned, found none" — and it is one pass over symbols this path already holds.
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    for (const id of ["s1", "s2", "s3", "s4"]) {
      await writeFile(join(tmpDir, `${id}.jsonl`), session(id, 2));
    }
    // A compacted session carries a `user` record flagged `isCompactSummary` — the extractor collects
    // those separately and emits the LAST one as a `conversation_summary` symbol. `type: "summary"` is
    // not a shape it recognises, which is what the first draft of this test wrote.
    await writeFile(join(tmpDir, "s3.jsonl"), [
      session("s3", 2),
      JSON.stringify({
        type: "user", isCompactSummary: true,
        message: { content: "earlier turns were compacted away" },
        uuid: "u-sum", sessionId: "s3", timestamp: "2026-09-27T09:00:00Z",
      }),
    ].join("\n"));
    const full = await indexConversations(tmpDir, { embed: false });
    expect(full.compacted_sessions).toBe(1);

    await writeFile(join(tmpDir, "s1.jsonl"), session("s1", 4));
    const incr = await indexConversations(tmpDir, { embed: false });
    expect(incr.incremental).toBe(true);
    // The compacted session was NOT the one that changed, so the count has to come from the merged
    // symbols rather than from this pass's own scan.
    expect(incr.compacted_sessions).toBe(1);
  });

  it("writes only the changed session's rows, leaving the rest of the index untouched", async () => {
    // `saveIndex` rewrites every symbol of the repo — measured 1,494 ms on a 15,838-symbol index
    // against 0-1 ms for `saveIncremental` on one file, for a pass whose whole premise is that two
    // sessions moved. The observable guarantee is that untouched sessions keep their stored rows.
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    const { getIndexPath, loadIndex } = await import("../../src/storage/index-store.js");
    const { loadConfig } = await import("../../src/config.js");
    for (const id of ["s1", "s2", "s3", "s4"]) {
      await writeFile(join(tmpDir, `${id}.jsonl`), session(id, 2));
    }
    await indexConversations(tmpDir, { embed: false });
    const indexPath = getIndexPath(loadConfig().dataDir, tmpDir);
    const before = await loadIndex(indexPath);
    const untouchedBefore = before.symbols.filter((x) => x.file === "s4.jsonl").map((x) => x.id).sort();

    await writeFile(join(tmpDir, "s1.jsonl"), session("s1", 5));
    expect((await indexConversations(tmpDir, { embed: false })).incremental).toBe(true);

    const after = await loadIndex(indexPath);
    expect(after.symbols.filter((x) => x.file === "s4.jsonl").map((x) => x.id).sort())
      .toEqual(untouchedBefore);
    // And the changed one really was replaced, not appended to.
    const s1Ids = new Set(after.symbols.filter((x) => x.file === "s1.jsonl").map((x) => x.id));
    expect(s1Ids.size).toBeGreaterThan(before.symbols.filter((x) => x.file === "s1.jsonl").length);
    expect(after.files.map((f) => f.path).sort()).toEqual(["s1.jsonl", "s2.jsonl", "s3.jsonl", "s4.jsonl"]);
  });

  it("leaves a BM25 header the next search accepts, after incremental writes", async () => {
    // Both `saveIncremental` and `removeFileFromIndex` stamp `updated_at` themselves, so the header
    // has to be written from the value the database ends up with. Getting that wrong means every later
    // search rejects the file and rebuilds — silently undoing this whole path.
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    const { getIndexPath, loadIndex } = await import("../../src/storage/index-store.js");
    const { loadConfig } = await import("../../src/config.js");
    const { loadBM25Index } = await import("../../src/search/bm25-store.js");
    for (const id of ["s1", "s2", "s3", "s4"]) {
      await writeFile(join(tmpDir, `${id}.jsonl`), session(id, 2));
    }
    await indexConversations(tmpDir, { embed: false });
    await writeFile(join(tmpDir, "s2.jsonl"), session("s2", 5));
    expect((await indexConversations(tmpDir, { embed: false })).incremental).toBe(true);

    const indexPath = getIndexPath(loadConfig().dataDir, tmpDir);
    const code = await loadIndex(indexPath);
    const bm25 = await loadBM25Index(indexPath, code);
    expect(bm25).not.toBeNull();
    expect(bm25!.docCount).toBe(code.symbols.length);
  });

  it("falls back to a full pass when most of the directory changed", async () => {
    // Past half the directory, amending file by file stops being cheaper than one pass — and the full
    // path also refreshes what the incremental one cannot.
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    for (const id of ["s1", "s2", "s3", "s4"]) {
      await writeFile(join(tmpDir, `${id}.jsonl`), session(id, 2));
    }
    await indexConversations(tmpDir, { embed: false });

    for (const id of ["s1", "s2", "s3"]) {
      await writeFile(join(tmpDir, `${id}.jsonl`), session(id, 5));
    }
    const r = await indexConversations(tmpDir, { embed: false });
    expect(r.incremental).toBeUndefined();
    expect(r.sessions_found).toBe(4);
  });

  it("falls back to a full pass when there is no persisted index to amend", async () => {
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    const { getIndexPath } = await import("../../src/storage/index-store.js");
    const { loadConfig } = await import("../../src/config.js");
    const { bm25PathFor } = await import("../../src/search/bm25-store.js");
    for (const id of ["s1", "s2", "s3", "s4"]) {
      await writeFile(join(tmpDir, `${id}.jsonl`), session(id, 2));
    }
    await indexConversations(tmpDir, { embed: false });
    await unlink(bm25PathFor(getIndexPath(loadConfig().dataDir, tmpDir)));

    await writeFile(join(tmpDir, "s2.jsonl"), session("s2", 4));
    const r = await indexConversations(tmpDir, { embed: false });
    expect(r.incremental).toBeUndefined();
    expect(r.sessions_found).toBe(4);
  });
});

describe("conversation indexing — persisted BM25", () => {
  it("writes a BM25 file beside the index", async () => {
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    await writeFile(join(tmpDir, "s1.jsonl"), session("s1", 4));
    await indexConversations(tmpDir, { embed: false });

    const { getIndexPath } = await import("../../src/storage/index-store.js");
    const { loadConfig } = await import("../../src/config.js");
    const { bm25PathFor } = await import("../../src/search/bm25-store.js");
    expect(existsSync(bm25PathFor(getIndexPath(loadConfig().dataDir, tmpDir)))).toBe(true);
  });

  it("the persisted index loads against the index it was written with", async () => {
    // The header is stamped from the code index `persistConversationIndex` saves. If those two ever
    // disagree the file is dead weight — written on every index, rejected on every search.
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    await writeFile(join(tmpDir, "s1.jsonl"), session("s1", 4));
    await indexConversations(tmpDir, { embed: false });

    const { getIndexPath, loadIndex } = await import("../../src/storage/index-store.js");
    const { loadConfig } = await import("../../src/config.js");
    const { loadBM25Index } = await import("../../src/search/bm25-store.js");
    const indexPath = getIndexPath(loadConfig().dataDir, tmpDir);
    const code = await loadIndex(indexPath);
    const bm25 = await loadBM25Index(indexPath, code);
    expect(bm25).not.toBeNull();
    expect(bm25!.docCount).toBe(code.symbols.length);
  });

  it("search still finds a turn added after the first search", async () => {
    // End to end over both changes: the freshness check, the skip, and the persisted file have to
    // agree, or the combination reintroduces the 27-hour stale answer the bound used to hide.
    const { indexConversations } = await import("../../src/tools/conversation-tools.js");
    const { searchConversations } = await import("../../src/tools/conversation-search-tools.js");
    const path = join(tmpDir, "s1.jsonl");
    await writeFile(path, session("s1", 2));
    await indexConversations(tmpDir, { embed: false });
    const before = await searchConversations("retention", tmpDir, 20);

    // A turn is a user record PAIRED with an assistant reply — a lone user record is not extracted,
    // which is what the first draft of this test appended and then asserted on.
    await writeFile(path, [
      session("s1", 2),
      JSON.stringify({
        type: "user", message: { content: "a brand new question about orphaned temp files" },
        uuid: "u-new", sessionId: "s1", timestamp: "2026-09-27T12:00:00Z",
      }),
      JSON.stringify({
        type: "assistant", message: { content: [{ type: "text", text: "they are swept after an hour" }] },
        uuid: "a-new", sessionId: "s1",
      }),
    ].join("\n"));
    await indexConversations(tmpDir, { embed: false });
    const after = await searchConversations("orphaned temp files", tmpDir, 20);

    expect(after.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(after.results)).toContain("orphaned temp files");
    expect(before.results.some((r) => r.user_question.includes("orphaned"))).toBe(false);
  });
});
