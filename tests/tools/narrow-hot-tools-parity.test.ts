// ADR-004 stage 2, hot core tools: each of these used to materialise the WHOLE index and filter it,
// and now asks the database for the rows it uses. The failure this codebase keeps meeting is a
// narrow read that returns FEWER rows and reports success, so each tool is checked against the
// answer the full index gives:
//
//   - "resident": the full index is in the tool-layer cache, so every accessor filters the
//     materialised array in memory — the old path's semantics;
//   - "narrow":   the cache is empty, so the same call goes to SQLite;
//
// and, for the lookups whose old body was a one-line filter, against that filter applied to the full
// index directly. A real repository is indexed — not a mock — because what is being compared is the
// storage layer's answer with the array's.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexFolder, getCodeIndex, stopAllWatchersForTesting } from "../../src/tools/index-tools.js";
import { codeIndexes } from "../../src/tools/index-tools/state.js";
import { getFileOutline, getFileTree, getRepoOutline, suggestQueries } from "../../src/tools/outline-tools.js";
import {
  findSimilarSymbols,
  getSymbol,
  getSymbols,
  resolveSymbolIdExact,
} from "../../src/tools/symbol-lookup-tools.js";
import { searchText } from "../../src/tools/search-tools.js";
import { changedSymbols, diffOutline } from "../../src/tools/diff-tools.js";
import { checkTextStubHint } from "../../src/register-tool-groups/shared.js";
import { resetConfigCache } from "../../src/config.js";
import type { CodeIndex } from "../../src/types.js";

const REPO = "local/narrow-parity";
let tmpDir: string;
let root: string;
let full: CodeIndex;

function git(...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    stdio: "ignore",
  });
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "codesift-narrow-parity-"));
  root = join(tmpDir, "narrow-parity");
  await mkdir(join(root, "src", "nested"), { recursive: true });
  process.env["CODESIFT_DATA_DIR"] = join(tmpDir, ".codesift");
  resetConfigCache();

  // Two declarations named `handler` in different files (name lookups must stay ambiguous), a
  // class with methods (children), and locals inside a function (the outline's hidden locals).
  await writeFile(join(root, "src", "user-service.ts"), `export interface User { id: string }

export class UserService {
  findAll(): User[] {
    return [];
  }

  deleteUser(id: string): void {
    const user = this.findAll().find((u) => u.id === id);
    const reason = "gone";
    if (!user) throw new Error(reason);
  }
}

export function handler(): number {
  const local = 1;
  return local;
}
`);
  await writeFile(join(root, "src", "payment.ts"), `export function processPayment(amount: number): boolean {
  return amount > 0;
}

export function handler(): string {
  return "payment";
}
`);
  await writeFile(join(root, "src", "nested", "util.ts"), `export const formatCurrency = (n: number): string => n.toFixed(2);
export function uniqueUtility(): void {}
`);
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  // Second commit: a NEW file (its symbols are "added") and a hunk inside processPayment
  // ("modified"), so the diff tools have both shapes to get right.
  await writeFile(join(root, "src", "payment.ts"), `export function processPayment(amount: number): boolean {
  return amount > 10;
}

export function handler(): string {
  return "payment";
}
`);
  await writeFile(join(root, "src", "added.ts"), `export function brandNew(): void {}
export class AddedThing {
  run(): void {}
}
`);
  git("add", ".");
  git("commit", "-q", "-m", "two");

  await indexFolder(root, { watch: false });
  const loaded = await getCodeIndex(REPO);
  if (!loaded) throw new Error("fixture failed to index");
  full = loaded;
});

afterAll(async () => {
  await stopAllWatchersForTesting();
  delete process.env["CODESIFT_DATA_DIR"];
  resetConfigCache();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Run `call` once with the full index resident and once with only the database, and return both. */
async function bothPaths<T>(call: () => Promise<T>): Promise<{ resident: T; narrow: T }> {
  await getCodeIndex(REPO); // make it resident
  const resident = await call();
  codeIndexes.clear();
  const narrow = await call();
  return { resident, narrow };
}

const shortId = (id: string): string => id.slice(id.indexOf(":") + 1);

describe("outline tools", () => {
  it("get_file_outline lists exactly the file's symbols, in line order, on both paths", async () => {
    for (const file of ["src/user-service.ts", "src/payment.ts", "src/nested/util.ts", "src/none.ts"]) {
      const { resident, narrow } = await bothPaths(() => getFileOutline(REPO, file, { includeLocals: true }));
      expect(narrow, file).toEqual(resident);
      // Against the old body applied to the full index: filter by file, stable sort by start line.
      const expected = full.symbols
        .filter((s) => s.file === file)
        .sort((a, b) => a.start_line - b.start_line)
        .map((s) => s.id);
      expect(narrow.symbols.map((s) => s.id), file).toEqual(expected);
    }
  });

  it("get_file_outline hides the same locals on both paths", async () => {
    const { resident, narrow } = await bothPaths(() => getFileOutline(REPO, "src/user-service.ts"));
    expect(narrow).toEqual(resident);
    expect(narrow.locals_hidden ?? 0).toBeGreaterThan(0);
  });

  it("get_file_tree, get_repo_outline and suggest_queries answer the same on both paths", async () => {
    for (const call of [
      () => getFileTree(REPO),
      () => getFileTree(REPO, { compact: true }),
      () => getFileTree(REPO, { path_prefix: "src/nested" }),
      () => getRepoOutline(REPO),
      () => suggestQueries(REPO),
    ]) {
      const { resident, narrow } = await bothPaths(call);
      expect(narrow).toEqual(resident);
    }
    const outline = await getRepoOutline(REPO);
    expect(outline.total_symbols).toBe(full.symbols.length);
    expect(outline.total_files).toBe(full.files.length);
  });

  it("suggest_queries counts every symbol's kind, not a page of them", async () => {
    const result = await suggestQueries(REPO);
    const counted = Object.values(result.kind_distribution).reduce((a, b) => a + b, 0);
    expect(counted).toBe(full.symbols.length);
  });

  it("keeps the not-found error for an unknown repo", async () => {
    await expect(getFileOutline("local/does-not-exist", "a.ts")).rejects.toThrow(
      'Repository "local/does-not-exist" not found. Run index_folder first.',
    );
  });
});

describe("symbol lookup tools", () => {
  it("get_symbol resolves a full id and a short id to the same symbol, with source from disk", async () => {
    const target = full.symbols.find((s) => s.name === "processPayment")!;
    for (const id of [target.id, shortId(target.id)]) {
      const { resident, narrow } = await bothPaths(() => getSymbol(REPO, id));
      expect(narrow, id).toEqual(resident);
      expect(narrow?.symbol.name).toBe("processPayment");
      expect(narrow?.symbol.source).toContain("amount > 10");
    }
  });

  it("get_symbol prefetches a class's children in index order, as the filter did", async () => {
    const cls = full.symbols.find((s) => s.name === "UserService" && s.kind === "class")!;
    const { resident, narrow } = await bothPaths(() => getSymbol(REPO, cls.id));
    expect(narrow).toEqual(resident);
    const expected = full.symbols.filter((s) => s.parent === cls.id).slice(0, 20).map((s) => shortId(s.id));
    expect(expected.length).toBeGreaterThan(0);
    expect((narrow?.related ?? []).map((s) => s.id)).toEqual(expected);
  });

  it("get_symbol returns null for an id nothing answers to", async () => {
    const { resident, narrow } = await bothPaths(() => getSymbol(REPO, "src/payment.ts:nothing:99"));
    expect(resident).toBeNull();
    expect(narrow).toBeNull();
  });

  it("get_symbols returns every requested symbol, in request order, skipping unknown ids", async () => {
    const picks = full.symbols.filter((s) => ["handler", "formatCurrency", "deleteUser"].includes(s.name));
    const ids = [
      shortId(picks[2]!.id),
      "src/missing.ts:ghost:1",
      picks[0]!.id,
      shortId(picks[1]!.id),
      shortId(picks[3]!.id),
    ];
    const { resident, narrow } = await bothPaths(() => getSymbols(REPO, ids));
    expect(narrow).toEqual(resident);
    expect(narrow.map((s) => s.id)).toEqual([picks[2], picks[0], picks[1], picks[3]].map((s) => shortId(s!.id)));
  });

  it("resolve_symbol_id_exact stays ambiguous for a name declared twice", async () => {
    const { resident, narrow } = await bothPaths(() => resolveSymbolIdExact(REPO, "nowhere:handler:1"));
    expect(resident).toBeNull();
    expect(narrow).toBeNull();
    const unique = await bothPaths(() => resolveSymbolIdExact(REPO, "stale:uniqueUtility:77"));
    expect(unique.narrow).toBe(full.symbols.find((s) => s.name === "uniqueUtility")!.id);
    expect(unique.narrow).toBe(unique.resident);
  });

  it("find_similar_symbols ranks the same suggestions on both paths", async () => {
    for (const guess of ["src/x.ts:handler:1", "src/x.ts:Payment:1", "src/x.ts:user:1"]) {
      const { resident, narrow } = await bothPaths(() => findSimilarSymbols(REPO, guess, 5));
      expect(narrow, guess).toEqual(resident);
      expect(narrow.length, guess).toBeGreaterThan(0);
    }
  });
});

describe("search_text", () => {
  it("returns the same matches whether or not it ranks", async () => {
    for (const call of [
      () => searchText(REPO, "handler"), // identifier query, grouping omitted -> ranked
      () => searchText(REPO, "return", { regex: false, group_by_file: true }),
      () => searchText(REPO, "export (function|class)", { regex: true, file_pattern: "src/**/*.ts" }),
    ]) {
      const { resident, narrow } = await bothPaths(call);
      // Compared as a set: ripgrep searches files in parallel, so the order ACROSS files differs
      // between two identical runs — that is rg, not the index, and neither path controls it.
      expect(canonical(narrow)).toEqual(canonical(resident));
      expect(canonical(narrow).length).toBeGreaterThan(0);
    }
  });
});

function canonical(result: unknown): string[] {
  if (typeof result === "string") return result.split("\n").sort();
  return (result as unknown[]).map((r) => JSON.stringify(r)).sort();
}

describe("diff tools", () => {
  it("diff_outline reports the same added and modified symbols as a walk over every symbol", async () => {
    const { resident, narrow } = await bothPaths(() => diffOutline(REPO, "HEAD~1", "HEAD"));
    expect(narrow).toEqual(resident);
    expect(narrow.added.map((s) => s.name).sort()).toEqual(
      full.symbols.filter((s) => s.file === "src/added.ts").map((s) => s.name).sort(),
    );
    expect(narrow.modified.map((s) => s.name)).toContain("processPayment");
    expect(narrow.modified.map((s) => s.name)).not.toContain("formatCurrency"); // file not in the diff
    // Whole symbols, as before — source included.
    expect(narrow.added.every((s) => typeof s.source === "string")).toBe(true);
  });

  it("changed_symbols lists every symbol name of every changed file", async () => {
    const { resident, narrow } = await bothPaths(() => changedSymbols(REPO, "HEAD~1", "HEAD"));
    expect(narrow).toEqual(resident);
    const files = narrow.map((e) => e.file).sort();
    expect(files).toEqual(["src/added.ts", "src/payment.ts"]);
    for (const entry of narrow) {
      expect(entry.symbols, entry.file).toEqual(full.symbols.filter((s) => s.file === entry.file).map((s) => s.name));
    }
  });
});

describe("H11 stub hint", () => {
  it("reads the file list the same way on both paths", async () => {
    const { resident, narrow } = await bothPaths(() => checkTextStubHint(REPO, "search_symbols", true));
    expect(narrow).toEqual(resident);
  });
});
