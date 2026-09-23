import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";
import { TOOL_DEFINITION_MAP } from "../../src/register-tools/discovery.js";
import { resetShownSourceLedgerForTesting } from "../../src/server-helpers/shown-source.js";

// Handler level: the ledger's contract is only as good as the order in which the tool handlers
// check, render and commit — which the unit tests of shown-source.ts cannot see.
const REPO = "local/dedup-project";
let tmpDir: string;
const saved: Record<string, string | undefined> = {};

async function call(tool: string, args: Record<string, unknown>): Promise<string> {
  const def = TOOL_DEFINITION_MAP.get(tool);
  if (!def) throw new Error(`no tool ${tool}`);
  return String(await def.handler({ repo: REPO, ...args }));
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-dedup-"));
  const root = join(tmpDir, "dedup-project");
  await mkdir(join(root, "src"), { recursive: true });
  for (const k of ["CODESIFT_DATA_DIR", "CODESIFT_DISABLE_LOCAL_EMBEDDINGS", "CODESIFT_MAX_RESPONSE_TOKENS"]) saved[k] = process.env[k];
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  process.env["CODESIFT_DISABLE_LOCAL_EMBEDDINGS"] = "true";
  delete process.env["CODESIFT_MAX_RESPONSE_TOKENS"];
  resetConfigCache();
  await writeFile(join(root, "src", "small.ts"), "export function smallOne(): number {\n  return 42;\n}\n");
  const body = Array.from({ length: 200 }, (_, i) => `  const value${i} = "${"x".repeat(20)}";`).join("\n");
  await writeFile(join(root, "src", "big.ts"), `export function hugeOne(): number {\n${body}\n  return 0;\n}\n`);
  await indexFolder(root);
  resetShownSourceLedgerForTesting(true);
});

afterEach(async () => {
  resetShownSourceLedgerForTesting(false);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("shown-source dedup through the tool handlers", () => {
  it("answers an unchanged repeat of get_symbol with a pointer, and full_source resends", async () => {
    expect(await call("get_symbol", { symbol_id: "smallOne" })).toContain("return 42;");
    const repeat = await call("get_symbol", { symbol_id: "smallOne" });
    expect(repeat).not.toContain("return 42;");
    expect(repeat).toContain("source unchanged");
    expect(await call("get_symbol", { symbol_id: "smallOne", full_source: true })).toContain("return 42;");
  });

  // Every check happens before any commit, so the second copy cannot point at the first.
  it("sends a symbol listed twice in one get_symbols call in full both times", async () => {
    const out = await call("get_symbols", { symbol_ids: ["smallOne", "smallOne"] });
    expect(out).not.toContain("source unchanged");
  });

  // The same body reached through tools that name the symbol differently (with and without the
  // repo prefix) is one symbol to the ledger.
  it("carries the ledger across tools that return the same body", async () => {
    await call("get_symbols", { symbol_ids: ["smallOne"] });
    expect(await call("explore", { query: "smallOne", top: 1 })).toContain("source unchanged");
    await call("find_and_show", { query: "smallOne" });
    expect(await call("get_symbol", { symbol_id: "smallOne" })).toContain("source unchanged");
  });

  // get_symbol/find_and_show render the declaration without its `export` keyword; get_symbols and
  // explore include it. A different body is resent: the pointer may only claim "unchanged" when it is.
  it("resends when another tool's rendering of the body differs", async () => {
    await call("get_symbol", { symbol_id: "smallOne" });
    expect(await call("get_symbols", { symbol_ids: ["smallOne"] })).toContain("return 42;");
  });

  // The cap is about to cut this body, so the agent will not receive it — recording it would earn
  // a later "unchanged" pointer for code the agent never saw.
  it("does not record a body the response cap will cut", async () => {
    process.env["CODESIFT_MAX_RESPONSE_TOKENS"] = "1000";
    await call("get_symbol", { symbol_id: "hugeOne" });
    const again = await call("get_symbol", { symbol_id: "hugeOne" });
    expect(again).not.toContain("source unchanged");
    expect(again).toContain("const value199");
  });
});
