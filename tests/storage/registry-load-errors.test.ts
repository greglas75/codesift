// `loadRegistry` used to be one `try { ... } catch { return emptyRegistry(); }`, so EVERY failure
// meant "no repos are indexed". EACCES on the registry file, EMFILE under load, a transient I/O
// error — each made every repo on the machine look unindexed, tools answered
// `Repository ... not found. Run index_folder first.`, and an agent that believed them re-indexed
// the world. The data was fine; only the read had failed.
//
// `loadGroupRegistry` already splits these three ways and its header calls the distinction
// CRITICAL-1. These tests hold `loadRegistry` to the same contract.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRegistry } from "../../src/storage/registry.js";

let dir: string;
let regPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-reg-"));
  regPath = join(dir, "registry.json");
});

afterEach(() => {
  try { chmodSync(regPath, 0o644); } catch { /* may not exist */ }
  rmSync(dir, { recursive: true, force: true });
});

// Root reads through permission bits, so the EACCES case proves nothing there.
const canDenyReads = typeof process.getuid === "function" && process.getuid() !== 0;

describe("loadRegistry error semantics", () => {
  it("treats a missing file as a first run", async () => {
    const reg = await loadRegistry(regPath);
    expect(reg.repos).toEqual({});
  });

  it.skipIf(!canDenyReads)("THROWS on an unreadable file rather than reporting an empty machine", async () => {
    // The distinction the whole change exists for: "I could not read it" must never be delivered
    // as "there is nothing here", because the caller's next move is to re-index everything.
    writeFileSync(regPath, JSON.stringify({ repos: { "local/x": { name: "local/x", root: "/x", index_path: "/x.json" } }, updated_at: 1 }));
    chmodSync(regPath, 0o000);
    await expect(loadRegistry(regPath)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("returns empty for corrupt JSON, but says so", async () => {
    // Unrecoverable here, so empty keeps the process usable — the warning is what stops it reading
    // as "nothing indexed".
    const errs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errs.push(args.join(" ")); };
    try {
      writeFileSync(regPath, "{ not json at all");
      const reg = await loadRegistry(regPath);
      expect(reg.repos).toEqual({});
    } finally {
      console.error = original;
    }
    expect(errs.join(" ")).toMatch(/not valid JSON/);
  });

  it("returns empty for a structurally wrong file, and says so", async () => {
    const errs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errs.push(args.join(" ")); };
    try {
      writeFileSync(regPath, JSON.stringify({ totally: "wrong" }));
      const reg = await loadRegistry(regPath);
      expect(reg.repos).toEqual({});
    } finally {
      console.error = original;
    }
    expect(errs.join(" ")).toMatch(/unexpected shape/);
  });

  it("still loads a valid registry unchanged", async () => {
    writeFileSync(regPath, JSON.stringify({
      repos: { "local/x": { name: "local/x", root: "/x", index_path: "/x.index.json" } },
      updated_at: 1,
    }));
    const reg = await loadRegistry(regPath);
    expect(Object.keys(reg.repos)).toHaveLength(1);
    expect(reg.repos["local/x"]?.name).toBe("local/x");
  });
});
