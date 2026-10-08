/**
 * nest_lifecycle_map and analyze_async_correctness on a REAL index (ADR-004 stage 2).
 *
 * Both used to walk `index.symbols` in full. nest_lifecycle_map now streams without source to find
 * the hooks and then reads only the files that hold one; analyze_async_correctness folds over pages.
 * The lifecycle result is compared against the original algorithm run over the materialised array,
 * so an ordering or pairing slip between the two passes is a visible difference.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetConfigCache } from "../../src/config.js";
import { getCodeIndex, indexFolder } from "../../src/tools/index-tools.js";
import { nestLifecycleMap } from "../../src/tools/nest-lifecycle-tools.js";
import { analyzeAsyncCorrectness } from "../../src/tools/async-correctness.js";
import type { CodeSymbol } from "../../src/types.js";

const FILES: Record<string, string> = {
  "src/app.service.ts": `import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";

@Injectable()
export class AppService implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.connect();
  }

  onModuleDestroy() {
    return undefined;
  }

  private async connect() {
    return undefined;
  }
}
`,
  "src/other.service.ts": `export class OtherService {
  onApplicationBootstrap() {
    return 1;
  }
}
`,
  "app/svc.py": `import time
import requests


async def fetch():
    return requests.get("http://example.invalid")


async def idle():
    time.sleep(1)


async def fine():
    await other()


def sync_fn():
    time.sleep(1)
`,
};

let tmpDir = "";
let repo = "";

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-scan-narrow-"));
  const projDir = join(tmpDir, "scan-narrow-project");
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();
  for (const [rel, content] of Object.entries(FILES)) {
    const full = join(projDir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  repo = (await indexFolder(projDir, { watch: false })).repo;
}, 60_000);

afterAll(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const LIFECYCLE_HOOKS = new Set([
  "onModuleInit", "onModuleDestroy", "onApplicationBootstrap", "onApplicationShutdown", "beforeApplicationShutdown",
]);

/** The pre-stage-2 algorithm, verbatim in substance, over the materialised array. */
function lifecycleOracle(symbols: CodeSymbol[]) {
  const hooks = [];
  for (const sym of symbols) {
    if (!LIFECYCLE_HOOKS.has(sym.name)) continue;
    if (sym.kind !== "method" && sym.kind !== "function") continue;
    let className = "Unknown";
    const classSym = symbols.find(
      (s) => s.file === sym.file && s.kind === "class" && s.start_line <= sym.start_line && s.end_line >= sym.end_line,
    );
    if (classSym) className = classSym.name;
    hooks.push({
      class_name: className,
      file: sym.file,
      hook: sym.name,
      is_async: /async\s/.test((sym.source ?? "").slice(0, 50)),
    });
  }
  return hooks;
}

// Async first: it never loads the full index, so both narrow reads below hit the database.
describe("analyze_async_correctness", () => {
  it("scans every async def and reports the blocking calls", async () => {
    const result = await analyzeAsyncCorrectness(repo);
    expect(result.async_functions_scanned).toBe(3);
    const byRuleAndSymbol = result.findings.map((f) => `${f.rule}:${f.symbol}`).sort();
    expect(byRuleAndSymbol).toEqual(expect.arrayContaining([
      "blocking-requests:fetch",
      "blocking-sleep:idle",
      "async-without-await:fetch",
      "async-without-await:idle",
    ]));
    expect(byRuleAndSymbol.some((f) => f.endsWith(":sync_fn") || f.endsWith(":fine"))).toBe(false);
  });

  it("stops scanning once max_results is reached", async () => {
    const capped = await analyzeAsyncCorrectness(repo, { max_results: 1 });
    expect(capped.async_functions_scanned).toBe(1);
    expect(capped.findings.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps its not-found message", async () => {
    await expect(analyzeAsyncCorrectness("local/no-such-repo")).rejects.toThrow(
      'Repository "local/no-such-repo" not found.',
    );
  });
});

describe("nest_lifecycle_map", () => {
  it("finds every hook with its class and async-ness, in index order", async () => {
    const result = await nestLifecycleMap(repo);
    expect(result.hooks.map((h) => [h.class_name, h.hook, h.is_async]).sort()).toEqual([
      ["AppService", "onModuleDestroy", false],
      ["AppService", "onModuleInit", true],
      ["OtherService", "onApplicationBootstrap", false],
    ]);
    // Loaded after the narrow read, so that read was served by the database.
    const full = await getCodeIndex(repo);
    expect(result.hooks).toEqual(lifecycleOracle(full!.symbols));
  });

  it("keeps its not-found message", async () => {
    await expect(nestLifecycleMap("local/no-such-repo")).rejects.toThrow(
      'Repository "local/no-such-repo" not found. Index it first with index_folder.',
    );
  });
});
