/**
 * Whole-feature smoke suite (tool-runtime-opt plan, Task 5) — proves Tasks 1-4
 * work end to end through the REAL bind path (registerToolDefinition + wrapTool),
 * not just as isolated unit tests. Assertions are deterministic (invocation
 * counts, marker shape, output shape); the only wall-clock dependence is SMOKE3,
 * which deliberately races a 60ms handler against a 15ms timeout — a timing gap
 * wide enough that it is not a threshold gate in practice.
 *
 *  SMOKE1 — usage_stats returns a version, no `Cannot find module` (Task 1).
 *  SMOKE2 — a cacheable tool against a REAL indexed repo is served from cache on
 *           the 2nd identical call (handler invoked exactly once across two
 *           calls, response marked `⚡ cached`), and MISSES once the repo's index
 *           changes — the cache is index-version-keyed, not permanent (Task 3).
 *  SMOKE3 — a handler slower than its timeout yields a valid ToolResponse
 *           envelope (`content:[{type:"text",...}]`, `isError:true`) whose
 *           parsed text has `status:"timed_out"`; the abandoned handler
 *           settling later (by REJECTING, the harder case) causes NO
 *           unhandled rejection (Task 3).
 *  SMOKE4 — get_file_tree defaults to the flat compact list; `compact:false`
 *           still returns the nested tree (Task 4).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  registerToolDefinition,
  resetToolRegistrationContext,
} from "../../src/register-tools/runtime.js";
import { resetSessionState } from "../../src/server-helpers.js";
import { META_TOOL_ENTRIES } from "../../src/register-tool-groups/meta.js";
import { CORE_TOOL_ENTRIES } from "../../src/register-tool-groups/core.js";
import { indexFolder } from "../../src/register-tool-groups/deps.js";
import {
  indexFolder as indexFolderDirect,
  indexFile as indexFileDirect,
  clearLastIndexedStateForTesting,
  stopAllWatchersForTesting,
  resetIndexFolderRedundancyForTesting,
} from "../../src/tools/index-tools.js";
import type { ToolDefinition } from "../../src/register-tool-groups/shared.js";
import type { ProjectLanguages } from "../../src/utils/language-detect.js";

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// SMOKE1 — usage_stats returns a version (Task 1)
// ---------------------------------------------------------------------------
describe("SMOKE1 — usage_stats returns a version (Task 1)", () => {
  it("resolves package.json without throwing and returns a non-empty version string", async () => {
    const entry = META_TOOL_ENTRIES.find((e) => e.definition.name === "usage_stats");
    if (!entry) throw new Error("usage_stats not registered in META_TOOL_ENTRIES");

    const result = (await entry.definition.handler({})) as { version?: unknown };
    expect(typeof result.version).toBe("string");
    expect((result.version as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SMOKE2 — cacheable tool served from cache on the 2nd identical call (Task 3)
// ---------------------------------------------------------------------------
describe("SMOKE2 — cacheable tool served from cache on 2nd identical call (Task 3)", () => {
  const origDataDir = process.env["CODESIFT_DATA_DIR"];
  const origDisableEmb = process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
  let dataDir: string;
  let repoRoot: string;
  let filePath: string;
  let repoName: string;

  beforeAll(async () => {
    // Isolate wrapTool's usage-tracking writes + the registry from the real
    // ~/.codesift dir. The cache is keyed on the repo's on-disk index version, so
    // this smoke MUST run against a REAL indexed repo: an unregistered repo has no
    // observable version and is (correctly) never cached at all.
    dataDir = await mkdtemp(join(tmpdir(), "cs-smoke-cache-data-"));
    process.env["CODESIFT_DATA_DIR"] = dataDir;
    process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = "1"; // hermetic + fast
    resetIndexFolderRedundancyForTesting();

    repoRoot = await mkdtemp(join(tmpdir(), "cs-smoke-cache-repo-"));
    await mkdir(join(repoRoot, "src"), { recursive: true });
    filePath = join(repoRoot, "src", "a.ts");
    await writeFile(filePath, "export function fn0() { return 0; }\n");
    await indexFolderDirect(repoRoot, { watch: false });

    const reg = JSON.parse(await readFile(join(dataDir, "registry.json"), "utf-8")) as {
      repos?: Record<string, { name: string }>;
    };
    const first = Object.values(reg.repos ?? {})[0];
    if (!first) throw new Error("repo was not registered after indexFolder");
    repoName = first.name;
  }, 60_000);

  afterAll(async () => {
    await stopAllWatchersForTesting();
    if (origDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
    else process.env["CODESIFT_DATA_DIR"] = origDataDir;
    if (origDisableEmb === undefined) delete process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"];
    else process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = origDisableEmb;
    await rm(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("invokes the handler exactly once across two identical calls, then MISSES after the index changes", async () => {
    let calls = 0;
    const handler: Handler = async () => {
      calls += 1;
      return `r${calls}`;
    };
    const call = bind(fakeDef("__smoke_cacheable__", handler, { cacheable: true }));
    const args = { repo: repoName, foo: 1 };

    resetSessionState();
    const first = (await call(args)) as { content?: Array<{ text?: string }> };
    expect(calls).toBe(1);
    expect(first.content?.[0]?.text ?? "").toContain("r1");

    // 2nd identical call at the SAME index version → served from the outer cache.
    // (cacheable tools bypass wrapTool's inner args-only cache, so this can only be
    // the index-version-aware outer cache.)
    const second = (await call(args)) as { content?: Array<{ text?: string }> };
    expect(calls).toBe(1); // NOT re-invoked
    expect(second.content?.[0]?.text ?? "").toContain("r1");
    expect(second.content?.[0]?.text ?? "").toContain("⚡ cached"); // hit is visible to the agent

    // Now CHANGE the repo (re-index) — the version component of the key moves, so
    // the entry must be invalidated immediately (no TTL window). Without this the
    // memoized answer would outlive the code it describes.
    await writeFile(filePath, "export function fn0() { return 0; }\nexport function fn1() { return 1; }\n");
    clearLastIndexedStateForTesting();
    await indexFileDirect(filePath);

    const third = (await call(args)) as { content?: Array<{ text?: string }> };
    expect(calls).toBe(2); // MISS — re-invoked against the new index version
    expect(third.content?.[0]?.text ?? "").toContain("r2");
    expect(third.content?.[0]?.text ?? "").not.toContain("⚡ cached");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// SMOKE3 — timeout returns a valid ToolResponse marker, no unhandled rejection (Task 3)
// ---------------------------------------------------------------------------
describe("SMOKE3 — timeout returns a valid ToolResponse marker (Task 3)", () => {
  const origDataDir = process.env["CODESIFT_DATA_DIR"];
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cs-smoke-timeout-data-"));
    process.env["CODESIFT_DATA_DIR"] = dataDir;
  });

  afterAll(async () => {
    if (origDataDir === undefined) delete process.env["CODESIFT_DATA_DIR"];
    else process.env["CODESIFT_DATA_DIR"] = origDataDir;
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("a handler slower than timeoutMs yields a content[] envelope with status:timed_out; the late REJECTION is swallowed (no unhandled rejection)", async () => {
    // Reject (not resolve) after the timeout — the harder case per
    // handler-wrappers.ts's withTimeout doc: "Attach an onRejected handler so
    // a late rejection after timeout is swallowed (never unhandled)."
    const handler: Handler = async () => {
      await sleep(60);
      throw new Error("late failure — must be swallowed, not unhandled");
    };
    const call = bind(fakeDef("__smoke_slow__", handler, { timeoutMs: 15 }));

    const res = (await call({ repo: "smoke/unregistered-repo" })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
      status?: unknown;
    };

    expect(Array.isArray(res.content)).toBe(true);
    expect(res.content?.[0]?.type).toBe("text");
    expect(typeof res.content?.[0]?.text).toBe("string");
    expect(res.isError).toBe(true);
    expect(res.status).toBeUndefined(); // not a bare top-level marker

    const payload = JSON.parse(res.content![0]!.text!) as {
      status?: string; tool?: string; timeout_ms?: number;
    };
    expect(payload.status).toBe("timed_out");
    expect(payload.tool).toBe("__smoke_slow__");
    expect(payload.timeout_ms).toBe(15);

    // Let the abandoned handler settle (reject). If withTimeout ever regressed
    // to leave this rejection unhandled, vitest would fail the run with an
    // "Unhandled Rejection" error surfaced against this test.
    await sleep(80);
  });
});

// ---------------------------------------------------------------------------
// SMOKE4 — get_file_tree compact-by-default (Task 4)
// ---------------------------------------------------------------------------
describe("SMOKE4 — get_file_tree compact-by-default (Task 4)", () => {
  let dir: string;
  let repo: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cs-smoke-tree-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "lib"), { recursive: true });
    await writeFile(join(dir, "src", "widget.ts"), "export function widget(): number { return 1; }\n");
    await writeFile(join(dir, "lib", "helper.ts"), "export const helper = 1;\n");

    const res = (await indexFolder(dir)) as { repo?: string } | undefined;
    repo = res?.repo ?? `local/${dir.split("/").pop()}`;
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults to the flat compact list; compact:false still returns the nested tree", async () => {
    const entry = CORE_TOOL_ENTRIES.find((e) => e.definition.name === "get_file_tree");
    if (!entry) throw new Error("get_file_tree not registered in CORE_TOOL_ENTRIES");
    const handler = entry.definition.handler;

    const byDefault = String(await handler({ repo }));
    const explicitFull = String(await handler({ repo, compact: false }));

    // The nested tree indents children; the compact flat list does not.
    const indentedLines = (s: string) => s.split("\n").filter((l) => /^\s+\S/.test(l)).length;

    expect(indentedLines(explicitFull), "compact:false must still nest (indented lines)").toBeGreaterThan(0);
    expect(indentedLines(byDefault), "default must be the flat compact list (no indentation)").toBe(0);
    expect(byDefault).not.toBe(explicitFull);
  });
});
