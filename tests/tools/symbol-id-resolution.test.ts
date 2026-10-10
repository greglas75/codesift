import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder } from "../../src/tools/index-tools.js";
import { getSymbol, resolveSymbolIdExact } from "../../src/tools/symbol-tools.js";
import { resetConfigCache } from "../../src/config.js";

const REPO = "local/symid-project";
const UNICODE_SOURCE = `// Zażółć gęślą jaźń — a comment with multi-byte characters
export function afterUnicode(): string {
  return "ok";
}
`;

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

  // Multi-byte text above a symbol: the stored offsets are UTF-16 code units, the file is UTF-8.
  await writeFile(join(fixtureDir, "src", "unicode.ts"), UNICODE_SOURCE);

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

describe("getSymbol source after multi-byte text", () => {
  // Bug: start_byte/end_byte were read as FILE BYTE offsets, but they count UTF-16 code units, so
  // every multi-byte character above a symbol moved the window back and cut its end short.
  it("returns exactly the declaration", async () => {
    const id = await resolveSymbolIdExact(REPO, "afterUnicode");
    const result = await getSymbol(REPO, id!, { include_related: false });
    expect(result?.symbol.source).toMatch(/^(export )?function afterUnicode\(\): string \{\n {2}return "ok";\n\}$/);
  });

  // Bug it catches: offsets from before an edit sliced the new text mid-token.
  it("falls back to whole indexed lines once the file has changed", async () => {
    const id = await resolveSymbolIdExact(REPO, "afterUnicode");
    const edited = `// one more line\n${UNICODE_SOURCE}`;
    await writeFile(join(fixtureDir, "src", "unicode.ts"), edited);
    const result = await getSymbol(REPO, id!, { include_related: false });
    const { start_line, end_line } = result!.symbol;
    expect(result?.symbol.source).toBe(edited.split("\n").slice(start_line - 1, end_line).join("\n"));
  });
});
