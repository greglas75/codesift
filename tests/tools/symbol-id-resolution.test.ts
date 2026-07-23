import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { getSymbol, resolveSymbolIdExact } from "../../src/tools/symbol-tools.js";
import { resetConfigCache } from "../../src/config.js";

const REPO = "local/symid-project";

let tmpDir: string;
let fixtureDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-symid-test-"));
  fixtureDir = join(tmpDir, "symid-project");
  await mkdir(join(fixtureDir, "src"), { recursive: true });

  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();

  await writeFile(
    join(fixtureDir, "src", "unique.ts"),
    `export function veryUniqueName(a: number): number {
  return a * 2;
}
`,
  );
  // Two symbols sharing a name — must stay ambiguous.
  await writeFile(
    join(fixtureDir, "src", "dupe-a.ts"),
    `export function sharedName(): string {
  return "a";
}
`,
  );
  await writeFile(
    join(fixtureDir, "src", "dupe-b.ts"),
    `export function sharedName(): string {
  return "b";
}
`,
  );

  await indexFolder(fixtureDir);
});

afterEach(async () => {
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("resolveSymbolIdExact — bare-name recovery for get_symbol/get_symbols", () => {
  it("resolves a bare symbol name to its canonical repo:file:name:line id", async () => {
    const id = await resolveSymbolIdExact(REPO, "veryUniqueName");
    expect(id).toBeTruthy();
    // The canonical form embeds the declaration line — which is exactly why a
    // caller cannot construct it and why this fallback exists.
    expect(id).toMatch(/:src\/unique\.ts:veryUniqueName:\d+$/);
  });

  it("returns null when the name is ambiguous rather than guessing", async () => {
    // Silently picking one of two `sharedName`s would hand back the wrong source
    // with no signal — strictly worse than the miss it would be replacing.
    expect(await resolveSymbolIdExact(REPO, "sharedName")).toBeNull();
  });

  it("returns null for a name that does not exist", async () => {
    expect(await resolveSymbolIdExact(REPO, "noSuchSymbolAnywhere")).toBeNull();
  });

  it("recovers the name from a partially-wrong id (stale line number)", async () => {
    const canonical = await resolveSymbolIdExact(REPO, "veryUniqueName");
    expect(canonical).toBeTruthy();
    // Same symbol, wrong line — the shape an agent produces from a stale outline.
    const stale = `${REPO}:src/unique.ts:veryUniqueName:999`;
    expect(await getSymbol(REPO, stale)).toBeFalsy();
    expect(await resolveSymbolIdExact(REPO, stale)).toBe(canonical);
  });

  it("the resolved id actually retrieves the symbol", async () => {
    const id = await resolveSymbolIdExact(REPO, "veryUniqueName");
    const result = await getSymbol(REPO, id as string);
    expect(result?.symbol.name).toBe("veryUniqueName");
  });
});
