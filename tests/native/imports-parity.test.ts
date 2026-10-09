// ADR-006 stage 4: the Rust import extractor must return exactly `extractTypeScriptImports`' edges —
// same order, kinds and type-only flags — or the import graph (circular deps, communities, impact's
// affected tests) silently changes. Real-code parity: scripts/native-imports-parity.ts.
//
// Runs only when the native core is loaded; tests/native/loader.test.ts fails a run that required one.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getNativeCore } from "../../src/native/index.js";
import { initParser, parseFile } from "../../src/parser/parser-manager.js";
import { collectImportEdges } from "../../src/utils/import-graph/collect.js";
import { extractTypeScriptImportsBatch } from "../../src/utils/import-graph/typescript-edge-collector.js";
import { extractTypeScriptImports } from "../../src/utils/ts-imports.js";

const native = (() => {
  try {
    return getNativeCore("parser");
  } catch {
    return null;
  }
})();

const CASES: Array<[string, string, string]> = [
  ["default, named, aliased and per-specifier type", "a.ts", `import a, { b as c, type D } from "./x";`],
  ["statement-level import type", "a.ts", `import type { E } from './y';`],
  ["only type specifiers", "a.ts", `import { type F, type G } from "./z";`],
  ["empty named clause is runtime", "a.ts", `import {} from "./empty";`],
  ["namespace and side-effect", "a.ts", `import * as ns from "./ns";\nimport "./side";`],
  ["import = require", "a.ts", `import req = require("./req");`],
  ["re-exports", "a.ts", `export { g, type H } from "./re";\nexport type { I } from "./ti";\nexport * from "./star";\nexport * as sp from "./sp";\nexport type * from "./tstar";`],
  ["local export walks on", "a.ts", `export const x = () => import("./inner");`],
  ["dynamic, then-chained, typeof import", "a.ts", `await import("./d");\nimport("./t").then(m => m);\ntype T = typeof import("./ty");`],
  ["require and runner mocks", "a.test.ts", `const r = require("./cjs");\nvi.mock("./m");\njest.requireActual("./ra");\nother.mock("./no");`],
  ["non-literal specifiers are skipped", "a.ts", "import(name);\nrequire(`./tpl`);\nrequire(\"\");"],
  ["declare module nests imports", "a.ts", `declare module "m" { import { X } from "./nested"; }`],
  ["tsx with jsx and require", "a.tsx", `import React from "react";\nexport const C = () => <div>{require("./b")}</div>;`],
  ["syntax errors still yield the edges they reach", "a.ts", `import { a } from "./ok";\nclass { method( }\nimport b from "./after";`],
  ["an exported string value is not a module", "a.ts", `export default "./x";\nexport = 'y';`],
  ["non-ascii specifiers", "a.ts", `import { zażółć as 中文 } from "./ünï🚀";`],
];

describe.skipIf(!native)("native import extraction matches extractTypeScriptImports", () => {
  beforeAll(async () => {
    await initParser();
  });

  it.each(CASES)("%s", async (_label, file, source) => {
    const tree = await parseFile(`/repo/${file}`, source);
    const want = extractTypeScriptImports(tree!);
    const got = await extractTypeScriptImportsBatch([{ path: file, source }]);
    expect(got.get(file)).toEqual(want);
  });

  describe("a file the core cannot parse", () => {
    const DEEP = `import { b } from "./b";\nconst x = ${"[".repeat(25_000)}1${"]".repeat(25_000)};\n`;
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "cs-imports-"));
      writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
      writeFileSync(join(dir, "deep.ts"), DEEP);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    // Bug it catches: a parse the core gives up on (here: deeper than MAX_TREE_DEPTH) read as "no
    // imports" and dropped the file's edges, instead of falling back to the TypeScript path.
    it("keeps its edges through the TypeScript path", async () => {
      const files = [{ path: "b.ts" }, { path: "deep.ts" }];
      const extracted = await extractTypeScriptImportsBatch([{ path: "deep.ts", source: DEEP }]);
      expect(extracted.has("deep.ts")).toBe(false);
      const edges = await collectImportEdges({ repo: "t", root: dir, files: files as never });
      expect(edges.map((e) => [e.from, e.to])).toEqual([["deep.ts", "b.ts"]]);
    });
  });
});
