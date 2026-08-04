import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import {
  getSymbol,
  findAndShow,
  getContextBundle,
  isAmbiguousSymbolIdError,
} from "../../src/tools/symbol-tools.js";
import { getCodeIndex } from "../../src/tools/index-tools.js";
import { resetConfigCache } from "../../src/config.js";

/**
 * `repo:file:name:line` is not unique. A caller that supplies a colliding id must be told, not
 * handed an arbitrary one of the candidates — but a SEARCH that merely reads an id back off its
 * own hit must not fail for the same reason.
 */

const REPO = "local/ambig-project";

let tmpDir: string;
let fixtureDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-ambig-"));
  fixtureDir = join(tmpDir, "ambig-project");
  await mkdir(join(fixtureDir, "src"), { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();

  // An id is `repo:file:NAME:line`, so a collision needs two DISTINCT symbols sharing all three.
  // TypeScript's separate type and value namespaces give exactly that: `Collide` is a type AND a
  // const, both declared on line 1 of the same file — different symbols, identical id. This is
  // the same shape the production comment cites for PHPDoc `@method` synthesis (a field and a
  // method at one line) and for minified bundles.
  await writeFile(
    join(fixtureDir, "src", "bundle.min.ts"),
    `export type Collide = number; export const Collide = 1;\nexport function collideUnique(){ return 3; }\n`,
  );
  await indexFolder(fixtureDir);
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Forge a colliding id by reusing an indexed symbol's file+line under another symbol's name. */
async function collidingId(): Promise<string | null> {
  const index = await getCodeIndex(REPO);
  if (!index) return null;
  const byId = new Map<string, number>();
  for (const s of index.symbols) byId.set(s.id, (byId.get(s.id) ?? 0) + 1);
  for (const [id, n] of byId) if (n > 1) return id;
  return null;
}

describe("ambiguous symbol ids", () => {
  it("getSymbol refuses a colliding id instead of picking one, and names the candidates", async () => {
    const id = await collidingId();
    // Fail loudly rather than skip: a fixture that stopped producing a collision would make every
    // assertion below vacuous while the test still reported green.
    expect(id).not.toBeNull();

    await expect(getSymbol(REPO, id!)).rejects.toThrow(/ambiguous/i);
    await getSymbol(REPO, id!).catch((err: unknown) => {
      expect(isAmbiguousSymbolIdError(err)).toBe(true);
      // The message must be actionable: which symbols collided, and what to do instead.
      expect((err as Error).message).toMatch(/search_symbols/);
    });
  });

  it("a search still answers when its own top hit carries a colliding id", async () => {
    // find_and_show reads the id back off a hit it already holds. Throwing there would turn a
    // collision into a worse answer than the silent substitution it replaced.
    const result = await findAndShow(REPO, "Collide", false);
    expect(result).not.toBeNull();
    expect(result!.symbol.name).toBe("Collide");
  });

  it("and SAYS the answer was one of several, rather than passing it off as unique", async () => {
    // Falling back is defensible; falling back silently is the substitution this codebase calls
    // the worst answer available. The field is unconditional so a caller can always check it.
    const result = await findAndShow(REPO, "Collide", false);
    expect(result!.id_ambiguity.status).toBe("ambiguous");
    expect(result!.id_ambiguity.shared_by).toBeGreaterThan(1);
    expect(result!.id_ambiguity.candidates!.length).toBeGreaterThan(1);

    const bundle = await getContextBundle(REPO, "Collide");
    expect(bundle!.id_ambiguity.status).toBe("ambiguous");
  });

  it("reports `unique` — not an absent field — when the id resolves to exactly one symbol", async () => {
    // An absent field would be indistinguishable from "nobody checked", which is the failure mode
    // this whole change exists to remove.
    const result = await findAndShow(REPO, "collideUnique", false);
    expect(result).not.toBeNull();
    expect(result!.id_ambiguity).toEqual({ status: "unique" });
  });
});
