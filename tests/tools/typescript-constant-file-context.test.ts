import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeTypeScriptFileContexts,
  loadTypeScriptFileContext,
  stripTypeScriptString,
} from "../../src/tools/typescript-constants/file-context.js";
import type {
  ResolutionState,
  TypeScriptFileContext,
} from "../../src/tools/typescript-constants/types.js";
import {
  createConstantResolutionFixture,
  type ConstantResolutionFixture,
} from "./helpers/constant-resolution-fixture.js";

let fixture: ConstantResolutionFixture;

beforeEach(async () => {
  fixture = await createConstantResolutionFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

function createState(parse: ResolutionState["parser"]["parse"]): ResolutionState {
  return {
    index: { root: fixture.root } as ResolutionState["index"],
    parser: { parse } as ResolutionState["parser"],
    fileCache: new Map(),
    retiredTrees: [],
    normalizedPathMap: new Map(),
    visited: new Set(),
    maxDepth: 8,
  };
}

describe("TypeScript constant file contexts", () => {
  it("strips matching string delimiters and preserves unquoted text", () => {
    expect(stripTypeScriptString("'single'")).toBe("single");
    expect(stripTypeScriptString("\"double\"")).toBe("double");
    expect(stripTypeScriptString("`template`")).toBe("template");
    expect(stripTypeScriptString("identifier")).toBe("identifier");
  });

  it("caches null for non-TypeScript and missing files without invoking the parser", async () => {
    const parse = vi.fn();
    const state = createState(parse as ResolutionState["parser"]["parse"]);

    await expect(loadTypeScriptFileContext(state, "src/config.js")).resolves.toBeNull();
    await expect(loadTypeScriptFileContext(state, "src/missing.ts")).resolves.toBeNull();
    await expect(loadTypeScriptFileContext(state, "src/missing.ts")).resolves.toBeNull();

    expect(parse).not.toHaveBeenCalled();
    expect(state.fileCache).toEqual(new Map([
      ["src/config.js", null],
      ["src/missing.ts", null],
    ]));
  });

  it("caches null when parsing a readable TypeScript file fails", async () => {
    await writeFile(join(fixture.root, "broken.ts"), "export const VALUE = 1\n");
    const parse = vi.fn(() => null);
    const state = createState(parse as ResolutionState["parser"]["parse"]);

    await expect(loadTypeScriptFileContext(state, "broken.ts")).resolves.toBeNull();
    await expect(loadTypeScriptFileContext(state, "broken.ts")).resolves.toBeNull();

    expect(parse).toHaveBeenCalledOnce();
    expect(state.fileCache).toEqual(new Map([["broken.ts", null]]));
  });

  it("bounds cached misses with the same limit as parsed file contexts", async () => {
    const parse = vi.fn();
    const state = createState(parse as ResolutionState["parser"]["parse"]);

    for (let index = 0; index < 129; index += 1) {
      await loadTypeScriptFileContext(state, `missing-${index}.js`);
    }

    expect(parse).not.toHaveBeenCalled();
    expect(state.fileCache.size).toBe(128);
    expect(state.fileCache.has("missing-0.js")).toBe(false);
    expect(state.fileCache.get("missing-128.js")).toBeNull();
  });

  it("rejects and disposes syntax-error trees before caching the miss", async () => {
    await writeFile(join(fixture.root, "broken.ts"), "export const VALUE = {\n");
    const deleteTree = vi.fn();
    const tree = {
      rootNode: { hasError: true, namedChildren: [] },
      delete: deleteTree,
    } as unknown as TypeScriptFileContext["tree"];
    const parse = vi.fn(() => tree);
    const state = createState(parse as ResolutionState["parser"]["parse"]);

    await expect(loadTypeScriptFileContext(state, "broken.ts")).resolves.toBeNull();
    await expect(loadTypeScriptFileContext(state, "broken.ts")).resolves.toBeNull();

    expect(parse).toHaveBeenCalledOnce();
    expect(deleteTree).toHaveBeenCalledOnce();
    expect(state.fileCache).toEqual(new Map([["broken.ts", null]]));
  });

  it("retires evicted trees and deletes them only during final disposal", async () => {
    await writeFile(join(fixture.root, "latest.ts"), "export const VALUE = 1\n");
    const deleteTree = vi.fn();
    const tree = {
      rootNode: { namedChildren: [] },
      delete: deleteTree,
    } as unknown as TypeScriptFileContext["tree"];
    const state = createState(vi.fn(() => tree) as ResolutionState["parser"]["parse"]);
    for (let index = 0; index < 128; index += 1) {
      state.fileCache.set(`cached-${index}.ts`, {
        source: "",
        tree,
        assignments: new Map(),
        imports: new Map(),
      });
    }

    await expect(loadTypeScriptFileContext(state, "latest.ts")).resolves.toMatchObject({ source: "export const VALUE = 1\n" });

    expect(state.fileCache.size).toBe(128);
    expect(state.retiredTrees).toHaveLength(1);
    expect(deleteTree).not.toHaveBeenCalled();

    disposeTypeScriptFileContexts(state);

    expect(deleteTree).toHaveBeenCalledTimes(129);
    expect(state.fileCache.size).toBe(0);
    expect(state.retiredTrees).toEqual([]);
  });
});
