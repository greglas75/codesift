import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMMAND_MAP } from "../../src/cli/commands.js";
import { resetConfigCache } from "../../src/config.js";

const LIVE = "aaaaaaaaaaaa";   // hash present in registry
const ORPH = "bbbbbbbbbbbb";   // hash NOT in registry

describe("codesift prune", () => {
  let dir: string;
  let stdout: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prune-"));
    process.env.CODESIFT_DATA_DIR = dir;
    resetConfigCache();
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => { stdout += String(c); return true; });
    // registry lists only the LIVE repo
    writeFileSync(join(dir, "registry.json"), JSON.stringify({
      repos: { "local/live": { name: "local/live", index_path: join(dir, `${LIVE}.index.json`) } },
    }));
    // live artifacts
    writeFileSync(join(dir, `${LIVE}.index.json`), "{}");
    writeFileSync(join(dir, `${LIVE}.embeddings.ndjson`), "x\n");
    // orphan artifacts (hash not in registry)
    writeFileSync(join(dir, `${ORPH}.index.json`), "{}");
    writeFileSync(join(dir, `${ORPH}.embeddings.ndjson`), "y\n".repeat(100));
    writeFileSync(join(dir, `${ORPH}.bm25.json`), "{}");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CODESIFT_DATA_DIR;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes orphan artifacts and keeps live ones", async () => {
    await COMMAND_MAP["prune"]!([], { json: true });
    // orphans gone
    expect(existsSync(join(dir, `${ORPH}.embeddings.ndjson`))).toBe(false);
    expect(existsSync(join(dir, `${ORPH}.index.json`))).toBe(false);
    expect(existsSync(join(dir, `${ORPH}.bm25.json`))).toBe(false);
    // live kept
    expect(existsSync(join(dir, `${LIVE}.embeddings.ndjson`))).toBe(true);
    expect(existsSync(join(dir, `${LIVE}.index.json`))).toBe(true);
    const out = JSON.parse(stdout);
    expect(out.orphan_files).toBe(3);
    expect(out.kept_live_artifacts).toBe(2);
    expect(out.pruned).toBe(true);
  });

  it("--dry-run reports but deletes nothing", async () => {
    await COMMAND_MAP["prune"]!([], { json: true, "dry-run": true });
    expect(existsSync(join(dir, `${ORPH}.embeddings.ndjson`))).toBe(true);
    const out = JSON.parse(stdout);
    expect(out.dry_run).toBe(true);
    expect(out.orphan_files).toBe(3);
  });

  it("aborts when the registry lists 0 repos (never treats all as orphans)", async () => {
    writeFileSync(join(dir, "registry.json"), JSON.stringify({ repos: {} }));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("die"); }) as never);
    await expect(COMMAND_MAP["prune"]!([], { json: true })).rejects.toThrow();
    // orphan still present — nothing was deleted
    expect(existsSync(join(dir, `${ORPH}.embeddings.ndjson`))).toBe(true);
    exit.mockRestore();
  });
});
