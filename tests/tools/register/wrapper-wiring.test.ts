import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerToolDefinition,
  resetToolRegistrationContext,
  getRepoIndexVersion,
  getRepoGitVersion,
  getRepoVersionToken,
  _resetRepoVersionTokenCache,
} from "../../../src/register-tools/runtime.js";
import { resetSessionState } from "../../../src/server-helpers.js";
import {
  indexFolder,
  indexFile,
  clearLastIndexedStateForTesting,
  stopAllWatchersForTesting,
  resetIndexFolderRedundancyForTesting,
} from "../../../src/tools/index-tools.js";
import type { ToolDefinition } from "../../../src/register-tool-groups/shared.js";
import type { ProjectLanguages } from "../../../src/utils/language-detect.js";

// ---------------------------------------------------------------------------
// Helpers — drive the REAL bind path (registerToolDefinition + wrapTool)
// ---------------------------------------------------------------------------

const NO_LANGS: ProjectLanguages = {
  python: false, php: false, typescript: false, javascript: false,
  kotlin: false, go: false, rust: false, ruby: false,
};

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/** Register a definition and return the bound MCP callback (composed wrappers). */
function bind(def: ToolDefinition): Handler {
  let captured: Handler | undefined;
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, cb: Handler) => {
      captured = cb;
      return { enabled: true, enable() {}, disable() {} };
    },
  } as unknown as Pick<McpServer, "tool">;
  // Clear the module-global handle map so re-used names (e.g. "index_file") register fresh.
  resetToolRegistrationContext(server, NO_LANGS);
  registerToolDefinition(server, def, NO_LANGS);
  if (!captured) throw new Error("server.tool callback was not captured");
  return captured;
}

function fakeDef(
  name: string,
  handler: Handler,
  opts: { cacheable?: boolean; timeoutMs?: number } = {},
): ToolDefinition {
  return { name, description: name, schema: {}, handler, ...opts };
}

/**
 * Parse the timeout marker payload from a ToolResponse envelope. The wiring
 * returns the marker as JSON inside `content[0].text` (a valid CallToolResult),
 * NOT as a bare top-level `{ status: "timed_out" }`. Returns null if absent.
 */
const timeoutPayload = (
  r: unknown,
): { status?: string; tool?: string; timeout_ms?: number } | null => {
  const content = (r as { content?: Array<{ type?: string; text?: string }> })?.content;
  const text = Array.isArray(content) ? content[0]?.text : undefined;
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text) as { status?: string; tool?: string; timeout_ms?: number };
    return parsed?.status === "timed_out" ? parsed : null;
  } catch {
    return null;
  }
};

const isTimeoutMarker = (r: unknown): boolean => timeoutPayload(r) !== null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Integration fixture — a real indexed temp repo (so the index-version signal
// resolves to a real on-disk {hash}.index.json we can mutate).
// ---------------------------------------------------------------------------

let dataDir: string;
let repoRoot: string;
let filePath: string;
let repoName: string;
let symCounter = 1;

const origDataDir = process.env["CODESIFT_DATA_DIR"];
const origDisableEmb = process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
const origTtlMs = process.env["CODESIFT_TOOL_CACHE_TTL_MS"];

/** Add one more symbol and re-index the file — an index_file-style mutation. */
async function bumpIndex(): Promise<void> {
  symCounter += 1;
  let body = "";
  for (let i = 0; i < symCounter; i++) body += `export function fn${i}() { return ${i}; }\n`;
  await writeFile(filePath, body);
  clearLastIndexedStateForTesting();
  await indexFile(filePath);
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cs-wrapwire-data-"));
  process.env["CODESIFT_DATA_DIR"] = dataDir;
  // Hermetic + fast: BM25 + symbols only (we only need the on-disk index file).
  process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = "1";
  // Deterministic invalidation: TTL=0 forces the per-repo version token to be
  // recomputed on every cacheKeyFor call, so an index_file-style / git mutation is
  // reflected immediately (no 2s memo window to race). The TTL memo itself is
  // proven separately, with a positive TTL, in the "TTL memo" test below.
  process.env["CODESIFT_TOOL_CACHE_TTL_MS"] = "0";
  resetIndexFolderRedundancyForTesting();

  repoRoot = await mkdtemp(join(tmpdir(), "cs-wrapwire-repo-"));
  await mkdir(join(repoRoot, "src"), { recursive: true });
  filePath = join(repoRoot, "src/a.ts");
  await writeFile(filePath, "export function fn0() { return 0; }\n");
  await indexFolder(repoRoot, { watch: false });

  // Resolve the registry-stored repo name (exact key for the version lookup).
  const reg = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf-8")) as {
    repos?: Record<string, { name: string }>;
  };
  const first = Object.values(reg.repos ?? {})[0];
  if (!first) throw new Error("repo was not registered after indexFolder");
  repoName = first.name;
});

afterAll(async () => {
  await stopAllWatchersForTesting();
  await rm(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (origDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
  else process.env["CODESIFT_DATA_DIR"] = origDataDir;
  if (origDisableEmb === undefined) delete process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
  else process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = origDisableEmb;
  if (origTtlMs === undefined) delete process.env["CODESIFT_TOOL_CACHE_TTL_MS"];
  else process.env["CODESIFT_TOOL_CACHE_TTL_MS"] = origTtlMs;
});

beforeEach(() => {
  clearLastIndexedStateForTesting();
  resetSessionState(); // clears the inner wrapTool response cache (NOT the outer withCache)
});

describe("register wrapper wiring", () => {
  // (0) SPIKE — prove the index-version signal exists, is reachable at the
  // wrapper layer, and CHANGES after an index_file-style mutation.
  it("SPIKE: repo index-version changes after an index_file-style mutation", async () => {
    const v1 = getRepoIndexVersion(repoName);
    expect(v1).not.toBe(""); // signal reachable for an indexed repo

    await bumpIndex();

    const v2 = getRepoIndexVersion(repoName);
    expect(v2).not.toBe("");
    expect(v2).not.toBe(v1);
  });

  it("SPIKE: unknown repo yields an empty (coarse) version — no crash", () => {
    expect(getRepoIndexVersion("no/such/repo")).toBe("");
    expect(getRepoIndexVersion("")).toBe("");
  });

  // (a) cacheable def → 2nd identical call (same index-version) served from cache.
  it("(a) cacheable tool: identical call at same index-version is served from cache", async () => {
    let calls = 0;
    const handler: Handler = async () => { calls += 1; return `r${calls}`; };
    const call = bind(fakeDef("__fake_cacheable__", handler, { cacheable: true }));

    await call({ repo: repoName, foo: 1 });
    expect(calls).toBe(1);

    resetSessionState(); // drop inner cache — only the outer withCache can serve now
    await call({ repo: repoName, foo: 1 });
    expect(calls).toBe(1); // served from outer cache — handler NOT re-invoked
  });

  // (a-cont) cache key includes the index-version → invalidates when index changes.
  it("(a) cacheable tool: cache invalidates when the repo index-version changes", async () => {
    let calls = 0;
    const handler: Handler = async () => { calls += 1; return `r${calls}`; };
    const call = bind(fakeDef("__fake_cacheable_ver__", handler, { cacheable: true }));

    await call({ repo: repoName, foo: 2 });
    expect(calls).toBe(1);

    await bumpIndex();       // index-version moves
    resetSessionState();     // clear inner cache so only the version-keyed outer cache decides

    await call({ repo: repoName, foo: 2 });
    expect(calls).toBe(2); // MISS because the version component changed
  });

  // (a-oop) OUT-OF-PROCESS staleness regression: a cacheable tool must be
  // re-invoked after the index changes EXTERNALLY (watcher / another session /
  // another machine re-indexing), NOT served stale by wrapTool's inner
  // args-only response cache.
  //
  // The inner cache is invalidated ONLY when an index-mutating tool runs IN THIS
  // session. bumpIndex() re-indexes the on-disk {hash}.index.json DIRECTLY (via
  // indexFile, not through the wrapTool-bound "index_file" callback), so the
  // repo index-version moves WITHOUT invalidating the inner cache and WITHOUT
  // resetSessionState() — faithfully simulating an external re-index.
  //
  // Pre-fix (inner cache also serves cacheable tools): call 2 gets an outer MISS
  // (version moved) → base → inner cache HIT on the unchanged args-only key →
  // returns STALE r1, handler NOT re-invoked (calls stays 1) → this test FAILS.
  // Post-fix (inner cache bypassed for cacheable tools): call 2 re-invokes the
  // handler (calls === 2) and the outer cache memoizes the fresh result.
  it("(a) cacheable tool: OUT-OF-PROCESS re-index re-invokes the handler (inner cache does NOT serve stale)", async () => {
    let calls = 0;
    const handler: Handler = async () => { calls += 1; return `r${calls}`; };
    const call = bind(fakeDef("__fake_cacheable_oop__", handler, { cacheable: true }));

    const first = (await call({ repo: repoName, foo: 42 })) as {
      content?: Array<{ text?: string }>;
    };
    expect(calls).toBe(1);
    expect(first.content?.[0]?.text ?? "").toContain("r1");

    // External re-index: on-disk index-version moves, inner cache untouched.
    // Deliberately NO resetSessionState() — that would mask the bug by clearing
    // the inner cache the way an in-session index_file would.
    await bumpIndex();

    const second = (await call({ repo: repoName, foo: 42 })) as {
      content?: Array<{ text?: string }>;
    };
    expect(calls).toBe(2); // RE-INVOKED — inner cache must not serve pre-change data
    expect(second.content?.[0]?.text ?? "").toContain("r2");
    // And it must NOT be a stale inner-cache hit masquerading as fresh.
    expect(second.content?.[0]?.text ?? "").not.toContain("r1");
  });

  // (a-error) FIX 2: an error result must NOT be memoized. wrapTool RESOLVES
  // failures as { isError: true } (it never rejects), so without eviction a
  // transient failure would stick in the outer cache until the index changed.
  it("(a) cacheable tool: an error result is NOT served from cache — retried next call", async () => {
    let calls = 0;
    const handler: Handler = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient boom"); // wrapTool → { isError: true }
      return `ok${calls}`;
    };
    const call = bind(fakeDef("__fake_cacheable_err__", handler, { cacheable: true }));

    const first = (await call({ repo: repoName, foo: 7 })) as { isError?: boolean };
    expect(calls).toBe(1);
    expect(first.isError).toBe(true); // resolved error envelope (not thrown)

    resetSessionState(); // drop the inner wrapTool cache; only the outer withCache could serve now
    const second = (await call({ repo: repoName, foo: 7 })) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    expect(calls).toBe(2); // RE-INVOKED — the error was NOT memoized by the outer cache
    expect(second.isError).not.toBe(true);
    expect(second.content?.[0]?.text ?? "").toContain("ok2");
  });

  // (b) a handler overrunning its timeout returns the timed-out marker.
  it("(b) overrunning handler returns the timed-out marker", async () => {
    const handler: Handler = async () => { await sleep(60); return "late"; };
    const call = bind(fakeDef("__fake_slow__", handler, { timeoutMs: 15 }));

    const res = await call({ repo: repoName });
    expect(isTimeoutMarker(res)).toBe(true);
    expect(timeoutPayload(res)?.tool).toBe("__fake_slow__");
    await sleep(80); // let the abandoned handler settle
  });

  // (b-envelope) FIX 1: the timeout path returns a valid ToolResponse envelope
  // (a `content` array of {type:"text"}), NOT a bare {status:"timed_out"} marker
  // — a content-less object is an invalid CallToolResult the SDK may reject.
  it("(b) timeout path returns a valid ToolResponse envelope, not a bare marker", async () => {
    const handler: Handler = async () => { await sleep(60); return "late"; };
    const call = bind(fakeDef("__fake_envelope_slow__", handler, { timeoutMs: 15 }));

    const res = (await call({ repo: repoName })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
      status?: unknown;
    };

    // Valid CallToolResult shape.
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.content?.[0]?.type).toBe("text");
    expect(typeof res.content?.[0]?.text).toBe("string");
    expect(res.isError).toBe(true);
    // NOT a bare {status:"timed_out"} at the top level.
    expect(res.status).toBeUndefined();
    // The marker payload lives inside content[0].text.
    const payload = JSON.parse(res.content![0]!.text!) as {
      status?: string; tool?: string; timeout_ms?: number;
    };
    expect(payload.status).toBe("timed_out");
    expect(payload.tool).toBe("__fake_envelope_slow__");
    expect(payload.timeout_ms).toBe(15);
    await sleep(80); // let the abandoned handler settle
  });

  // (c) a NON-metadata def is NOT cached, but STILL gets the universal timeout.
  it("(c) non-cacheable tool is not cached (handler runs each time)", async () => {
    let calls = 0;
    const handler: Handler = async () => { calls += 1; return `r${calls}`; };
    const call = bind(fakeDef("__fake_uncached__", handler)); // no cacheable

    await call({ repo: repoName, foo: 9 });
    resetSessionState(); // clear inner cache; no outer cache exists for a non-cacheable tool
    await call({ repo: repoName, foo: 9 });
    expect(calls).toBe(2); // re-invoked each time — nothing persistent cached it
  });

  it("(c) non-cacheable tool still gets the universal timeout marker", async () => {
    const handler: Handler = async () => { await sleep(60); return "late"; };
    const call = bind(fakeDef("__fake_uncached_slow__", handler, { timeoutMs: 15 }));

    const res = await call({ repo: repoName });
    expect(isTimeoutMarker(res)).toBe(true);
    await sleep(80);
  });

  // (d) an exempt tool name is NOT timeout-wrapped.
  it("(d) exempt tool (index_file) is not timeout-wrapped — it runs to completion", async () => {
    const handler: Handler = async () => { await sleep(50); return "done-exempt"; };
    const call = bind(fakeDef("index_file", handler, { timeoutMs: 5 }));

    const res = await call({ repo: repoName });
    expect(isTimeoutMarker(res)).toBe(false);
    // real ToolResponse envelope with the completed payload
    const text = (res as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
    expect(text).toContain("done-exempt");
  });

  // (3) tool_timeout telemetry is written to the usage log on a timeout.
  it("logs a tool_timeout usage event when a timeout fires", async () => {
    const handler: Handler = async () => { await sleep(60); return "late"; };
    const call = bind(fakeDef("__fake_telemetry_slow__", handler, { timeoutMs: 15 }));

    await call({ repo: repoName });

    // The shared usage log also collects tool_timeout entries from the other
    // timeout tests — match THIS test's uniquely-named entry.
    const usagePath = join(dataDir, "usage.jsonl");
    let found: Record<string, unknown> | undefined;
    await expect.poll(async () => {
      const raw = await readFile(usagePath, "utf-8").catch(() => "");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as Record<string, unknown>;
        const summary = entry["args_summary"] as { tool?: string } | undefined;
        if (entry["tool"] === "tool_timeout" && summary?.tool === "__fake_telemetry_slow__") {
          found = entry;
          return true;
        }
      }
      return false;
    }, { timeout: 2000 }).toBe(true);

    expect(found?.["repo"]).toBe(repoName);
    expect((found?.["args_summary"] as { timeout_ms?: number })?.timeout_ms).toBe(15);
    await sleep(80);
  });
});

// ---------------------------------------------------------------------------
// Git-state cache invalidation — some cacheable tools (audit_scan bundles
// analyze_hotspots git churn; architecture_summary surfaces git-derived data)
// read GIT state, not just the code index. After a commit / branch checkout the
// on-disk {hash}.index.json can be UNCHANGED, so the index-version token alone
// would serve STALE pre-commit git metrics for the life of a long-lived process.
// The cache version now folds in getRepoGitVersion(repo) so git-state changes
// bump the key. This suite runs against a REAL git repo (the outer fixture is a
// non-git temp dir, so it can't exercise the HEAD-moved-but-index-unchanged case).
// ---------------------------------------------------------------------------
describe("register wrapper wiring — git-state cache invalidation", () => {
  let gitRepoRoot: string;
  let gitRepoName: string;
  let gitFilePath: string;

  const commit = (msg: string, allowEmpty = false): void => {
    execFileSync(
      "git",
      [
        "-C", gitRepoRoot, "-c", "user.email=t@t", "-c", "user.name=t",
        "commit", "-q", ...(allowEmpty ? ["--allow-empty"] : []), "-m", msg,
      ],
      { stdio: "ignore" },
    );
  };
  const head = (): string =>
    execFileSync("git", ["-C", gitRepoRoot, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();

  beforeAll(async () => {
    // dataDir + CODESIFT_DATA_DIR + CODESIFT_DISABLE_LOCAL_EMBEDDINGS are set by
    // the outer describe's beforeAll (module-scoped fixture), so this repo lands
    // in the same registry the version lookups read.
    gitRepoRoot = await mkdtemp(join(tmpdir(), "cs-wrapwire-git-"));
    await mkdir(join(gitRepoRoot, "src"), { recursive: true });
    gitFilePath = join(gitRepoRoot, "src/g.ts");
    await writeFile(gitFilePath, "export function g0() { return 0; }\n");

    execFileSync("git", ["-C", gitRepoRoot, "init", "-q"], { stdio: "ignore" });
    execFileSync("git", ["-C", gitRepoRoot, "add", "-A"], { stdio: "ignore" });
    commit("init");

    await indexFolder(gitRepoRoot, { watch: false });

    // Resolve the registered repo name. os.tmpdir() may be a symlink (/var →
    // /private/var on macOS) so the stored root can differ from gitRepoRoot by
    // prefix — match on basename, which is unaffected by the symlink.
    const reg = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf-8")) as {
      repos?: Record<string, { name: string; root: string }>;
    };
    const target = basename(gitRepoRoot);
    const entry = Object.values(reg.repos ?? {}).find((r) => basename(r.root) === target);
    if (!entry) throw new Error("git repo was not registered after indexFolder");
    gitRepoName = entry.name;
  });

  afterAll(async () => {
    await rm(gitRepoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // Unit: exception-safe coarse fallback ("") for unknown / non-git repos; a real
  // HEAD:dirty-flag token for a git repo.
  it("getRepoGitVersion: '' for unknown/non-git repo, HEAD token for a git repo", () => {
    // Unknown repo id → not in registry → coarse fallback, never throws.
    expect(getRepoGitVersion("no/such/repo")).toBe("");
    expect(getRepoGitVersion("")).toBe("");
    // The outer fixture repo root is a plain (non-git) temp dir → "".
    expect(getRepoGitVersion(repoName)).toBe("");
    // A real git repo → `${headSha}:${c|d}` token.
    expect(getRepoGitVersion(gitRepoName)).toMatch(/^[0-9a-f]{7,}:[cd]$/);
  });

  // A cacheable tool must be RE-INVOKED when git HEAD changes even though the
  // indexed source (and thus the on-disk index file) is UNCHANGED — proving
  // git-state is part of the cache key. Also confirms identical git+index state
  // still serves from cache (no spurious miss).
  it("cacheable tool: re-invoked when git HEAD moves but the index file does NOT", async () => {
    let calls = 0;
    const handler: Handler = async () => { calls += 1; return `r${calls}`; };
    const call = bind(fakeDef("__fake_cacheable_git__", handler, { cacheable: true }));

    await call({ repo: gitRepoName, foo: 1 });
    expect(calls).toBe(1);

    // Identical git + index state → served from the outer cache (no spurious miss).
    resetSessionState();
    await call({ repo: gitRepoName, foo: 1 });
    expect(calls).toBe(1);

    // Empty commit: HEAD moves, working tree + indexed source unchanged → the
    // {hash}.index.json is UNTOUCHED (getRepoIndexVersion is stable), so ONLY the
    // git token changes. This is exactly the pre-fix staleness case.
    const before = head();
    commit("empty", true);
    expect(head()).not.toBe(before); // HEAD really moved

    resetSessionState();
    await call({ repo: gitRepoName, foo: 1 });
    expect(calls).toBe(2); // MISS — git-state is in the cache key → fresh compute
  });

  // TTL memo: the per-repo version token is REUSED within the TTL window (no git
  // re-spawn / recompute), then recomputed after the window elapses — picking up a
  // git change made in between. This is the whole point of the fix: cacheKeyFor
  // runs on every call (incl. cache HITS), so without the memo each call would
  // spawn `git rev-parse` + `git status`. Proven with a POSITIVE TTL (the
  // surrounding suite runs at TTL=0 for deterministic immediate invalidation);
  // env is restored afterwards.
  it("TTL memo: version token is reused within the window, recomputed after TTL", () => {
    const prev = process.env["CODESIFT_TOOL_CACHE_TTL_MS"];
    process.env["CODESIFT_TOOL_CACHE_TTL_MS"] = "60000"; // long window
    _resetRepoVersionTokenCache();
    try {
      // First read populates the memo. Capture the raw git token as ground truth.
      const t1 = getRepoVersionToken(gitRepoName);
      expect(t1).toMatch(/\|[0-9a-f]{7,}:[cd]$/); // real `index|git` token
      const gitBefore = getRepoGitVersion(gitRepoName);
      expect(t1).toContain(gitBefore);

      // Move git HEAD. A RECOMPUTE would now yield a different token; the raw
      // (un-memoized) getRepoGitVersion confirms the ground truth actually moved.
      commit("memo-empty", true);
      const gitAfter = getRepoGitVersion(gitRepoName);
      expect(gitAfter).not.toBe(gitBefore);

      // Within the window: the memoized token is REUSED — NOT recomputed. Had the
      // git computation run again it would fold in gitAfter; it does not.
      const t2 = getRepoVersionToken(gitRepoName);
      expect(t2).toBe(t1);
      expect(t2).not.toContain(gitAfter);

      // TTL expiry (via TTL=0) → recompute → picks up the moved HEAD (correctness
      // contract preserved: a real change is reflected once the window elapses).
      process.env["CODESIFT_TOOL_CACHE_TTL_MS"] = "0";
      const t3 = getRepoVersionToken(gitRepoName);
      expect(t3).not.toBe(t1);
      expect(t3).toContain(gitAfter);
      expect(t3).toBe(
        `${getRepoIndexVersion(gitRepoName)}|${getRepoGitVersion(gitRepoName)}`,
      );
    } finally {
      if (prev === undefined) delete process.env["CODESIFT_TOOL_CACHE_TTL_MS"];
      else process.env["CODESIFT_TOOL_CACHE_TTL_MS"] = prev;
      _resetRepoVersionTokenCache();
    }
  });
});
