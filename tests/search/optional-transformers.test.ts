// `@huggingface/transformers` is an optionalDependency that both call sites already guard at
// runtime — but a statically-resolvable specifier made `tsc` need it anyway, so a missing optional
// package failed the BUILD instead of degrading the feature.
//
// It goes missing quietly and not rarely. Measured on burst-i9 2026-08-12: onnxruntime-node's
// postinstall found no `nvcc`, assumed CUDA 12, downloaded a multi-hundred-MB GPU tarball, died on
// `socket hang up`, and npm removed the failed optional package together with
// @huggingface/transformers (238 packages -> 207) while exiting 0. The first sign of trouble was
// TS2307, three steps later, in a place that names neither the download nor the dependency.
//
// A unit test cannot see that, because under test the package IS installed. So the guard is a
// source-level invariant: nothing in src/ may name the package in a resolvable position.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { walkDirectory } from "../../src/utils/walk.js";
import { importTransformers } from "../../src/search/optional-transformers.js";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const PKG = "@huggingface/transformers";
const ALLOWED = "optional-transformers.ts";

describe("optional transformers import", () => {
  it("is never named in a position tsc can resolve", async () => {
    const files = (await walkDirectory(SRC)).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(ALLOWED)) continue;
      const source = readFileSync(file, "utf-8");
      // Both a static `from "pkg"` and a dynamic `import("pkg")` with a LITERAL specifier are
      // resolvable and reintroduce TS2307; only the widened-variable form in the allowed module is
      // invisible to tsc.
      if (new RegExp(`(from|import\\s*\\()\\s*["']${PKG.replace("/", "\\/")}["']`).test(source)) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }

    expect(offenders, `import ${PKG} via importTransformers() instead`).toEqual([]);
  });

  it("only the dedicated module mentions the package at all", () => {
    const source = readFileSync(join(SRC, "search", ALLOWED), "utf-8");
    // The specifier must stay widened to `string`. Inlining it back to `import(SPECIFIER)` — where
    // SPECIFIER is a const with a literal type — is resolvable again and silently undoes the fix,
    // which is exactly the "simplification" the module's comment warns against.
    expect(source).toContain("const spec: string");
    expect(source).not.toMatch(/import\(\s*["']@huggingface/);
  });

  it("either yields the module or throws — never resolves to nothing", async () => {
    // This assertion must hold in BOTH environments, because the package's absence is the whole
    // point: it is installed on a dev machine and routinely absent on the test farm, where
    // onnxruntime-node's postinstall fails and npm drops it. An earlier version of this test
    // asserted `resolves.toBeDefined()` and failed on the farm — it encoded the very assumption
    // the fix exists to break.
    //
    // The contract callers rely on: `importTransformers()` resolves to a usable module, or it
    // throws so their existing `catch` marks the model failed. Resolving to null/undefined would
    // satisfy neither and move the crash to the first property access.
    try {
      const mod = await importTransformers();
      expect(mod).toBeDefined();
      expect(mod).not.toBeNull();
    } catch (err) {
      expect((err as { code?: string }).code).toBe("ERR_MODULE_NOT_FOUND");
    }
  });
});
