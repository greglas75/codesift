# TypeScript Extractor Expansion -- Design Specification

> **spec_id:** 2026-05-01-ts-extractor-expansion-0923
> **topic:** TypeScript Extractor Expansion (P0 + P1)
> **status:** Approved
> **created_at:** 2026-05-01T09:23:32Z
> **reviewed_at:** 2026-05-01T09:38:00Z
> **approved_at:** 2026-05-01T15:03:39Z
> **approval_mode:** interactive
> **adversarial_review:** clear
> **author:** zuvo:brainstorm

## Problem Statement

CodeSift's TypeScript extractor (`src/parser/extractors/typescript.ts`, 927 lines) covers
~60–65% of what LSP-backed competitors (Serena, mizchi/lsmcp via tsserver) extract and is
on par with tree-sitter-only competitors (GitNexus, jCodeMunch, codebase-memory) — except
for class heritage, which is the one differentiator GitNexus advertises and we omit.

The audit identified 17 gaps. This spec covers **P0 + P1** (11 gap items: L1, L2, L3, L4, L5, L7, L8, L9, L11, L12, L13). It excludes L6
(JSDoc tag parsing), L10 partial (object-literal value pairs already covered for methods),
L14 (tsconfig project references), L15 (configurable factory wrappers — `cva`/`tv`/etc.),
and L16 (`satisfies`). Those defer to a v2 spec.

The 11 gap items in scope:

| ID  | Gap                                                                        |
| --- | -------------------------------------------------------------------------- |
| L4  | `extends[]` / `implements[]` capture on classes                            |
| L7  | Generics (`type_parameters`) included in `signature`                       |
| L13 | `tsconfig.json` paths/baseUrl resolution in import-graph                   |
| L1  | `import type` and `import { type X }` flagged as `type_only` import edges  |
| L3  | Enum members extracted (kind = `constant`)                                 |
| L5  | `is_async` flag set on TS async functions/methods/arrows                   |
| L8  | Modifiers (`static/abstract/readonly/private/public/protected/override`) into `meta.modifiers` |
| L9  | Accessor kind (`get`/`set`/`accessor`) into `meta.accessor_kind`           |
| L2  | `internal_module` (TS `namespace X {}` / `module M {}`; `declare module "x" {}` via `ambient_declaration` unwrap) emitted as `kind: "namespace"` |
| L11 | `export default <expression>` (anonymous) emitted with `name: "default"`, `kind: "default_export"` |
| L12 | `ambient_declaration` (`.d.ts`, `declare module/global/const`) walked into and re-emitted |

Affected users: every CodeSift user with TS/TSX projects — particularly monorepo (turborepo,
shadcn-style `@/*` aliases) and NestJS (decorator-heavy) repos. If we do nothing,
`find_circular_deps` produces false positives on type-only cycles, monorepo aliases never
resolve, and class-hierarchy queries return empty.

## Design Decisions

| Decision   | Choice                                                                 | Why                                                                                                                              |
| ---------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Scope      | P0 + P1 (11 gap items: L1–L5, L7, L8, L9, L11, L12, L13), exclude L6/L10p/L14/L15/L16 | One-shot reindex (single `EXTRACTOR_VERSIONS.typescript` bump from `2.1.0` to `3.0.0`), shippable in ~5–7 days, no third-party schema risk |
| `implements` field | Top-level `implements?: string[]` on `CodeSymbol`              | Symmetric with existing `extends?: string[]`; downstream tools discover it without reading `meta`                                |
| Enum members kind  | `kind: "constant"` (existing enum value)                       | Zero schema bump; matches user intuition (search `kind=constant` finds them); avoids cascading SymbolKind union changes          |
| Modifiers + accessors | `meta.modifiers?: string[]` + `meta.accessor_kind?: "get"\|"set"\|"accessor"` | Free-form `meta` bag exists; keeps top-level lean; new keys are additive convention             |
| L6 JSDoc tags     | Defer to v2                                                     | Requires schema extension OR new dep (`comment-parser`); ROI low until a downstream consumer exists                              |
| tsconfig resolver | `get-tsconfig` npm dep (privatenumber, ~46M/wk, MIT)             | Handles `extends` chain + cyclic + BOM + `paths`/`baseUrl` resolution. **Project references (`references[]`) NOT in scope — deferred to L14 v2.** Replaces ~150 lines of fragile hand-rolled regex |
| TS import extractor | New `src/utils/ts-imports.ts` (tree-sitter AST-based)          | Mirrors `python-imports.ts`. Required for `import type` per-specifier detection (regex cannot handle `import { type X, Y }`)     |
| `EXTRACTOR_VERSIONS` bump | Major bump; existing indexes return structured `{ stale: true }` error instead of empty results | Visible failure mode; users know to re-run `index_folder`                                                          |
| CI guard          | PR-check fails when `typescript.ts` diff lacks `EXTRACTOR_VERSIONS` diff | Forgotten bump is the BA's #1 risk; cheap to enforce                                                                       |
| Tests             | New `tests/parser/typescript-extractor-gaps.test.ts` + cross-grammar `.ts`/`.tsx` fixtures | Pin schema contract per gap; catch silent TSX drops                                                                |
| Default-export anon name | Synth `name: "default"`, `kind: "default_export"`        | Reuses existing `"default_export"` SymbolKind; mirrors CJS `module.exports = X` post-pass                                        |
| Stack-overflow safety | `try/catch RangeError` around `walk()` per-file; log warning, skip | Cheap (~5 lines), prevents one bad `.d.ts` killing entire `index_folder`                                              |

## Solution Overview

Three workstreams:

1. **Extractor expansion** — add cases and helpers in `typescript.ts` for `class_heritage`
   children, `type_parameters` in signatures, `enum_body` walk, `is_async` modifier check,
   modifier collection on methods/fields, accessor kind detection on `method_definition`,
   `internal_module` walk, `ambient_declaration` unwrap, anonymous
   `export default` synthesizing.
2. **Import-graph TS branch** — new `src/utils/ts-imports.ts` parses `import_statement`
   AND `export_statement` (with `source` field — `export * from "x"`, `export {X} from "x"`)
   nodes via tree-sitter, returns `{path, is_type_only, specifiers}`. `import-graph.ts`
   adds a TS branch alongside the existing Python branch (lines 355–386). The legacy
   `extractImports` regex is **retained as a per-file fallback** triggered only when the
   AST path throws — TS/TSX files normally use AST. JS files keep regex as primary
   (no `import type` syntax to detect).
3. **tsconfig path resolver** — new `src/utils/tsconfig-paths.ts` wraps `get-tsconfig`,
   exports `resolveTsAliasedImport(importerFile, importPath, repoRoot): string | null`.
   Called inside `import-graph.ts:resolveImportPath` BEFORE extension fallback. Cached
   per-repo via `Map<repoRoot, ParsedTsconfig>`.

Cross-cutting:
- `EXTRACTOR_VERSIONS.typescript` bumped from `2.1.0` to `3.0.0` in `src/tools/project-tools.ts`.
- `loadIndex()` already returns `null` on version mismatch; we add a structured error path
  so user-facing tools surface "stale, please re-run index_folder" instead of empty arrays.
- New CI workflow file `.github/workflows/extractor-version-guard.yml` failing PRs that
  diff `src/parser/extractors/typescript.ts` without diffing `EXTRACTOR_VERSIONS`.

## Detailed Design

### Data Model

`CodeSymbol` schema additions in `src/types.ts`:

```typescript
export interface CodeSymbol extends FileLocation {
  // ...existing fields...
  implements?: string[];   // NEW — symmetric with `extends?: string[]`
  // meta?: Record<string, unknown> already exists — used for new `modifiers` / `accessor_kind` keys
}
```

Conventional `meta` keys (no schema enforcement, but documented in `_shared.ts`):

| Key                     | Type                                            | Set by                                |
| ----------------------- | ----------------------------------------------- | ------------------------------------- |
| `meta.modifiers`        | `string[]` (e.g., `["static","readonly"]`)      | TS extractor on methods/fields        |
| `meta.accessor_kind`    | `"get" \| "set" \| "accessor"`                  | TS extractor on `method_definition`   |
| `meta.generator`        | `boolean` (already in use)                      | TS extractor on `generator_function_declaration` |

`ImportEdge` is exported only from `src/utils/import-graph.ts:19` (no canonical
definition in `src/types.ts`). The `type_only?: boolean` field already exists and is
currently populated only by the Python branch. **No schema edit required** — TS branch
simply starts populating the same existing field:

```typescript
// src/utils/import-graph.ts (existing — for reference, no diff)
export interface ImportEdge {
  from: string;
  to: string;
  type_only?: boolean;   // existing — TS branch will start setting it
  star_import?: boolean;
  raw?: string;
}
```

`SymbolKind` — no changes (we reuse existing `"constant"`, `"namespace"`, `"default_export"`,
`"method"`).

`EXTRACTOR_VERSIONS` in `src/tools/project-tools.ts`:

```typescript
export const EXTRACTOR_VERSIONS = {
  typescript: "3.0.0",  // was "2.1.0"
  // ...other languages unchanged
};
```

### API Surface

#### `src/utils/tsconfig-paths.ts` (NEW)

```typescript
import { getTsconfig, parseTsconfig, createPathsMatcher } from "get-tsconfig";

interface ResolvedTsconfig {
  pathsMatcher: ((specifier: string) => string[]) | null;
  baseUrl: string | null;
  configPath: string;
}

// Cache 1: parsed tsconfig per absolute config path (avoids re-parsing extends chains)
const configCache = new Map<string, ResolvedTsconfig | null>();
// Cache 2: directory → nearest tsconfig.json path (avoids O(N*depth) walk-up per import)
const dirToConfigCache = new Map<string, string | null>();

// Empty string first — probes the raw candidate path (handles aliases mapped to a
// concrete file, e.g., `paths: { "foo": ["src/foo.ts"] }`). Then the usual extensions.
// IMPORTANT: when the empty-string probe hits, we MUST verify the result is a FILE
// (not a directory) via `statSync().isFile()`. `existsSync` returns true for both;
// without the file-check, alias `@/components/Button` (a directory containing
// `index.ts`) would resolve to the directory path, then fail the `normalizedPaths`
// lookup (which only contains files), silently dropping the edge.
const TS_EXTENSIONS = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

/** Resolve a TS aliased import (e.g., "@/components/x") against the nearest tsconfig.json.
 *  Returns absolute path on disk if alias matches AND a real file exists with one of the
 *  candidate extensions, else null. */
export function resolveTsAliasedImport(
  importerFile: string,        // absolute path
  importPath: string,          // raw import specifier
  repoRoot: string,            // for cache key + walk-up termination
): string | null;

/** Clear caches (used by index invalidation). */
export function clearTsconfigCache(): void;
```

Behavior:
- Walk up from `dirname(importerFile)` to `repoRoot` to find nearest `tsconfig.json`.
  Use `dirToConfigCache` to avoid repeated stat calls; cache negatives too.
- `getTsconfig()` resolves `extends` chain (handles cyclic + node_modules + BOM internally).
  Cache parsed result in `configCache` keyed by absolute config path.
- Apply `pathsMatcher` to import specifier → list of candidate paths (may be relative
  to `baseUrl` or root).
- For each candidate, **probe extensions in `TS_EXTENSIONS` order** (alias mappings in
  `tsconfig.paths` typically omit extensions — `existsSync` on raw `"src/utils/foo"` is
  always false; we must try `foo.ts`, `foo.tsx`, `foo/index.ts`, etc.). Return first hit.
- Project references (`references[]`) are explicitly NOT followed — deferred to L14.

#### `src/utils/ts-imports.ts` (NEW)

```typescript
import type Parser from "web-tree-sitter";

export interface TsImportEdge {
  path: string;          // raw specifier, e.g., "./foo" or "@/lib/x"
  is_type_only: boolean; // entire statement is `import type` OR all specifiers are typed
  specifiers: string[];  // imported names (for future use)
}

/** Walk import_statement AND export_statement (with `source` field) in a TS/TSX tree.
 *  Re-exports `export {X} from "y"` and `export * from "y"` produce edges with
 *  `is_type_only: true` only when the export carries the `type` modifier
 *  (`export type {X} from "y"`); otherwise treated as runtime. */
export function extractTypeScriptImports(tree: Parser.Tree): TsImportEdge[];
```

Detection rules (per tree-sitter-typescript grammar):
- Statement-level `import`: `import_statement` with `type` modifier child → all specifiers type-only.
- Per-specifier (`import { type X, Y }`): `import_specifier` with leading `type` keyword node.
- If ALL named specifiers carry `type`, edge is `type_only: true`. If any runtime specifier
  exists, edge is `type_only: false` (BA edge case EC5).
- Default + namespace imports are runtime by definition (TS allows `import type Default from`
  but it's effectively the same as type-only statement; we honor statement-level flag).
- `export_statement` with `source` field: walked the same way. `export type {X} from "y"`
  and `export type * from "y"` → `type_only: true`. Plain `export {X} from "y"` and
  `export * from "y"` → `type_only: false`. Re-export specifiers are listed in `specifiers`.

#### `src/parser/extractors/typescript.ts` (CHANGES)

New `case` branches in `walk()`:

**Grammar note (verified against bundled `tree-sitter-typescript.wasm`):** the grammar
emits `internal_module` for `namespace X {}` AND for `module M {}`. For `declare module "x" {}`
the outer node is `ambient_declaration` containing an `internal_module` child. There is no
separate `module_declaration` node — handling `internal_module` plus `ambient_declaration`
unwrap covers all three syntaxes.

```typescript
case "internal_module": {        // namespace X {}, module M {}, also nested under ambient_declaration
  const name = getNodeName(node);
  if (name) {
    const exported = isExported || hasExportModifier(node);
    const sym = makeSymbol(node, name, "namespace", filePath, source, repo, {
      parentId,
      docstring: getDocstring(node, source),
      is_exported: exported ? true : undefined,
    });
    symbols.push(sym);
    // Walk body so nested function/class/interface declarations get parented
    const body = node.childForFieldName("body");
    if (body) for (const child of body.namedChildren) walk(child, sym.id, exported);
  }
  return;
}

case "ambient_declaration": {
  // declare const/class/function/interface/module — unwrap and walk inner.
  // Rule: ambient module declarations (`declare module "x" {}`) are intrinsically
  // module-public — there is no other way to expose them. So when the inner child is
  // `internal_module` with a STRING-literal name (i.e., declare module "x", not declare
  // module Foo), we treat it as exported. For other `declare X` forms (`declare const X`,
  // `declare function f`), we propagate the surrounding isExported plus the node's own
  // export modifier — `export declare const X` is exported, plain `declare const X`
  // inside a script file is ambient-only.
  const ambientExported = isExported || hasExportModifier(node);
  for (const child of node.namedChildren) {
    const isStringNamedModule = child.type === "internal_module"
      && child.childForFieldName("name")?.type === "string";
    walk(child, parentId, ambientExported || isStringNamedModule);
  }
  return;
}
```

`enum_declaration` case CHANGED — replace the existing `break` with a body walk so members
are emitted as parented constants:

```typescript
case "enum_declaration": {
  const name = getNodeName(node);
  if (name) {
    const exported = isExported || hasExportModifier(node);
    const sym = makeSymbol(node, name, "enum", filePath, source, repo, {
      parentId,
      docstring: getDocstring(node, source),
      is_exported: exported ? true : undefined,
    });
    symbols.push(sym);
    // NEW — walk enum_body children to emit members as `constant` parented to the enum
    const body = node.childForFieldName("body");
    if (body) {
      for (const child of body.namedChildren) {
        let memberName: string | null = null;
        if (child.type === "enum_assignment") memberName = getNodeName(child);
        else if (child.type === "property_identifier") memberName = child.text;
        if (memberName) {
          symbols.push(makeSymbol(child, memberName, "constant", filePath, source, repo, {
            parentId: sym.id,
          }));
        }
      }
    }
  }
  return;
}
```

Existing cases extended:

- `function_declaration` / `generator_function_declaration` / `method_definition` /
  `abstract_method_signature` / `arrow_function` (in `lexical_declaration`):
  set `is_async: hasAsyncModifier(node)` (new helper).
- `class_declaration` / `abstract_class_declaration`: collect `extends` and `implements`
  via new `getClassHeritage(node): { extends: string[]; implements: string[] }` helper
  (refactored out of existing `isReactClassComponent`).
- `enum_declaration`: walk into `enum_body` child to emit members (calls new case above).
- `method_definition`: detect `kind` field equal to `"get"`/`"set"`/`"accessor"`;
  set `meta.accessor_kind`. Collect `static`/`readonly`/`override`/accessibility into
  `meta.modifiers`.
- `public_field_definition` / `field_definition`: same modifier collection.
- `export_statement`: when child is unnamed `function_declaration` / `class_declaration`
  / `arrow_function` (anonymous default), synth `name: "default"`, `kind: "default_export"`.

`getSignature()` extended to prepend `type_parameters` when present. Note: the
`return_type` child in tree-sitter-typescript already includes the leading `:` (it points
to a `type_annotation` node containing the colon plus type), so we slice raw text without
prepending anything:

```typescript
function getSignature(node: Parser.SyntaxNode, source: string): string | undefined {
  const params = node.childForFieldName("parameters");
  if (!params) return undefined;
  const typeParams = node.childForFieldName("type_parameters");
  let sig = "";
  if (typeParams) sig += source.slice(typeParams.startIndex, typeParams.endIndex);
  sig += source.slice(params.startIndex, params.endIndex);
  const returnType = node.childForFieldName("return_type");
  if (returnType) sig += source.slice(returnType.startIndex, returnType.endIndex);
  return sig;
}
```

`getClassHeritage()` AST traversal rules (for AC #6 normalization):

```typescript
function getClassHeritage(node: Parser.SyntaxNode): { extends: string[]; implements: string[] } {
  const extendsList: string[] = [];
  const implementsList: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "class_heritage") continue;
    for (const clause of child.namedChildren) {
      const targetList = clause.type === "extends_clause" ? extendsList
                       : clause.type === "implements_clause" ? implementsList
                       : null;
      if (!targetList) continue;
      // A clause may contain multiple types: `extends A, B` or `implements I, J`
      for (const typeNode of clause.namedChildren) {
        const name = extractHeritageName(typeNode);
        if (name) targetList.push(name);
      }
    }
  }
  return { extends: extendsList, implements: implementsList };
}

// Strip type arguments, split intersection/union, preserve qualified names.
// Returns string[] (NOT string|null) so that intersection_type/union_type can
// expand to multiple elements at the call site.
function extractHeritageNames(node: Parser.SyntaxNode): string[] {
  // identifier → runtime base class name (e.g., `extends Foo` parses as `identifier`,
  // NOT `type_identifier`; tree-sitter-typescript treats the base class expression as
  // a runtime value). Without this case, all standard `extends X` clauses return null.
  if (node.type === "identifier") return [node.text];
  // type_identifier → TS-style type position (e.g., implements clauses)
  if (node.type === "type_identifier") return [node.text];
  // member_expression / nested_type_identifier → qualified name preserved
  if (node.type === "member_expression" || node.type === "nested_type_identifier") return [node.text];
  // generic_type → recurse into the type field, dropping type_arguments
  if (node.type === "generic_type") {
    const innerType = node.childForFieldName("name") ?? node.namedChildren[0];
    return innerType ? extractHeritageNames(innerType) : [];
  }
  // intersection_type / union_type → expand each member to a separate string
  if (node.type === "intersection_type" || node.type === "union_type") {
    return node.namedChildren.flatMap((child) => extractHeritageNames(child));
  }
  return [];
}
```

`getClassHeritage` uses `flatMap(extractHeritageNames)` over each clause's named
children, so `extends Foo & Bar` produces `["Foo", "Bar"]` automatically. AC #6's
normalization rule is satisfied without needing a separate "callers handle list
expansion" step — the helper does it itself.

Top-level `walk()` invocation wrapped:

```typescript
try {
  walk(tree.rootNode);
} catch (err) {
  if (err instanceof RangeError && /Maximum call stack/i.test(err.message)) {
    console.warn(`[ts-extractor] stack overflow on ${filePath}; skipping with partial symbols`);
    return symbols;  // partial extraction is acceptable
  }
  throw err;
}
```

#### `src/utils/import-graph.ts` (CHANGES)

Add TS branch alongside Python (around line 355):

```typescript
if (file.path.endsWith(".ts") || file.path.endsWith(".tsx")) {
  try {
    const lang = file.path.endsWith(".tsx") ? "tsx" : "typescript";
    const parser = await getParser(lang);
    if (parser) {
      // Reuse parse tree from the symbol-extraction pass via getCachedParse.
      // Source-keyed cache means same-content lookup hits and we avoid double-parsing.
      let tree = getCachedParse(lang, source);
      if (!tree) { tree = parser.parse(source); setCachedParse(lang, source, tree); }
      const tsImports = extractTypeScriptImports(tree);
      for (const imp of tsImports) {
        let resolved: string | null = null;
        if (imp.path.startsWith(".")) {
          resolved = resolveImportPath(file.path, imp.path);
        } else {
          // Try tsconfig alias before treating as bare specifier
          const aliased = resolveTsAliasedImport(
            join(index.root, file.path), imp.path, index.root,
          );
          if (aliased) resolved = relative(index.root, aliased);
        }
        const targetFile = resolved ? normalizedPaths.get(resolved) : null;
        if (targetFile) addEdge(file.path, targetFile, { type_only: imp.is_type_only });
      }
    }
  } catch (err) { /* log + skip */ }
}
```

Existing regex-based `extractImports()` retained for `.js`/`.jsx` and PHP files.

#### `src/tools/index-tools.ts` (CHANGES)

`loadIndex()` currently returns `null` on version mismatch. We change it to return a
discriminated union (TypeScript-internal contract) and add a tool-side wrapper that
converts `status:"stale"` into the standard MCP `isError: true` error envelope (wire
contract). This preserves backward compatibility for MCP clients — they handle the new
case the same way they already handle any other tool error.

```typescript
// src/tools/index-tools.ts (internal TS contract)
export type IndexOrStaleResult =
  | { status: "ok"; index: CodeIndex }
  | { status: "stale"; reason: "extractor_version_mismatch"; expected_version: string; actual_version: string };

export async function loadIndexOrStale(repoPath: string): Promise<IndexOrStaleResult>;

// src/tools/_helpers.ts (wire contract — used by every tool wrapper that reads an index)
export function staleToMcpError(stale: { reason: string; expected_version: string; actual_version: string }) {
  return {
    isError: true as const,
    content: [{
      type: "text" as const,
      text: `Index stale: ${stale.reason} (expected ${stale.expected_version}, got ${stale.actual_version}). Run index_folder to refresh.`,
    }],
  };
}
```

Migration scope: ~20 `loadIndex(` call sites across `src/tools/*` (this is a multi-file
refactor — not a single-file change despite the new code living in two files). Each call
site becomes:

```typescript
const result = await loadIndexOrStale(repoPath);
if (result.status === "stale") return staleToMcpError(result);
const { index } = result;
// ...rest of tool body unchanged...
```

`clearTsconfigCache()` is called at the top of `index_folder` so config edits between
runs take effect (gemini iter-2 finding).

### Integration Points

1. `src/types.ts:42-57` — add `implements?: string[]` to `CodeSymbol`.
2. `src/parser/extractors/typescript.ts:538-927` — extractor expansion (2 new cases:
   `internal_module`, `ambient_declaration`; 5 case extensions: `function_declaration`,
   `generator_function_declaration`, `method_definition`, `abstract_method_signature`,
   `class_declaration`, `enum_declaration`, `public_field_definition`/`field_definition`,
   `export_statement` for anonymous default; modified `getSignature` to prepend
   `type_parameters`; top-level `try/catch RangeError` wrap; new helpers `getClassHeritage`,
   `hasAsyncModifier`, `getModifiers`, `getAccessorKind`).
3. `src/parser/extractors/_shared.ts:23-68` — `makeSymbol` opts type already has `meta`;
   add `implements?: string[]` to opts and pipe to `sym.implements`.
4. `src/utils/import-graph.ts:302-390` — new TS branch; call `resolveTsAliasedImport`.
5. `src/utils/ts-imports.ts` (NEW) — TS AST import extractor.
6. `src/utils/tsconfig-paths.ts` (NEW) — `get-tsconfig` wrapper with cache.
7. `src/tools/project-tools.ts:22-35` — bump `EXTRACTOR_VERSIONS.typescript` to `"3.0.0"`.
8. `src/tools/index-tools.ts:997-1000` + `index_folder` entry-point — change `loadIndex`
   to return discriminated union; add `loadIndexOrStale` helper; call
   `clearTsconfigCache()` at the start of `index_folder` so config edits between runs
   take effect. Add `staleToMcpError` helper in `src/tools/_helpers.ts` that converts
   the union to the standard MCP `{ isError: true, content }` envelope. Update all
   `loadIndex(` callers in `src/tools/*` (~20 sites) to use `loadIndexOrStale` +
   `staleToMcpError`. **This is a multi-file refactor**, not a single-file edit.
9. `package.json` — add `get-tsconfig: ^4.13.0` to `dependencies`.
10. `.github/workflows/extractor-version-guard.yml` (NEW) — CI lint.
11. `tests/parser/typescript-extractor-gaps.test.ts` (NEW) — gap-pinning tests.
12. `tests/parser/tsconfig-paths.test.ts` (NEW) — alias resolution tests.
13. `tests/utils/ts-imports.test.ts` (NEW) — `import type` detection tests.
14. `tests/fixtures/tsconfig-monorepo/` (NEW) — root + packages/foo with `extends` chain.

Out of scope but unblocked for follow-up specs: `nest-tools.ts` regex → `sym.decorators`
consumption, `hono.ts:extractImportMap` consolidation, `react-alias.ts` tsconfig path use.

### Interaction Contract

Two cross-cutting behavioral changes that integrators must know about:

| Surface                              | Old behavior                                                    | New behavior                                                                                | Override order             | Validation signal                                                  | Rollback boundary               |
| ------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------ | ------------------------------- |
| Tool result on stale index           | Empty `symbols: []` array, no error indication                  | MCP standard error envelope: `{ isError: true, content: [{ type: "text", text: "Index stale: extractor_version_mismatch (expected 3.0.0, got 2.1.0). Run index_folder to refresh." }] }`. The `loadIndexOrStale` helper returns a discriminated union internally to TypeScript callers, but the wire shape is the standard MCP error envelope so existing client code paths handle it as any other tool error | Helper function `loadIndexOrStale` (internal) → tool wrapper converts `{status:"stale",...}` to MCP `isError:true` envelope | Contract test asserts every tool, on stale index, returns `isError: true` with text content matching `/extractor_version_mismatch/` | Revert PR + bump back to `2.1.0` |
| `find_circular_deps` cycle list      | Includes type-only edges (regex flagged everything as runtime)  | Filters out edges where `edge.type_only === true` ONLY (`undefined` treated as runtime); pure type-only TS cycles disappear from output. JS/JSX/PHP cycle detection unchanged | Filter happens in cycle finder, not the import-graph builder | Pre-existing tests pinned via fixtures; new test asserts type-only cycle is omitted; JS-only cycle test still passes | Same as above |

**Protected surfaces** (must NOT change behavior in this spec): every existing
`SymbolKind` value, JSON wire format of `CodeSymbol` (only additive fields), MCP tool
parameter schemas, `index_folder` / `index_status` return shapes, all non-TS extractors,
`async-correctness` tool's gating logic (it must remain Python-only until a follow-up
spec extends it).

**Release notes MUST call out:** structured stale-index error, fewer cycles after upgrade
(if user repo had type-only cycles), `is_async` populated on TS symbols (consumers that
filter on it now get TS hits).

### Edge Cases

| Label                                     | Category    | Handling                                                                                       |
| ----------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| TSX vs TS grammar node-type mismatch (EC1)| integration | Each new `case` ships with `.ts` + `.tsx` fixture; CI fails if either diverges                  |
| `.d.ts` with UTF-8 BOM (EC2a)             | data        | `get-tsconfig` strips BOM internally; for source files, tree-sitter handles BOM; verified via fixture |
| Cyclic `tsconfig` extends chain (EC2b)    | integration | `get-tsconfig` has visited-set guard; we add fixture asserting no hang                          |
| Anonymous `export default function() {}` (EC3) | data    | Synth `name: "default"`, `kind: "default_export"`; test fixture                                |
| Stage-3 vs experimental decorators (EC4)  | integration | Tree-sitter emits identical `decorator` node; existing logic correct. Add `node.hasError()` warn log only |
| `import { type X, Y }` mixed (EC5)        | data        | AST-based per-specifier check in `ts-imports.ts`. Edge `type_only: true` only when all specifiers are typed |
| Stack overflow on huge `.d.ts` (EC6)      | timing      | `try/catch RangeError` around `walk(tree.rootNode)`; log warning, return partial; iterative walk deferred to v2 |
| Forgotten `EXTRACTOR_VERSIONS` bump (EC7) | tooling     | CI guard fails PR; release blocked                                                             |
| Concurrent `index_folder` race (EC8)      | timing      | Pre-existing issue, out of scope; flagged in BACKLOG                                           |
| Monorepo tsconfig precedence (EC9)        | integration | Walk up from importer file to nearest `tsconfig.json`; `get-tsconfig` resolves `extends`        |
| `find_circular_deps` type-only false-positive (EC10) | data | Filter `edge.type_only !== true` in `find_circular_deps`; updated test                  |
| `.js`/`.jsx` regression (EC11)            | data        | JS path keeps regex `IMPORT_PATTERNS`; only `.ts`/`.tsx` switch to AST. JSDoc generics not in scope |
| `.d.ts` ambient with no body              | data        | `internal_module` case checks `body` field for null before iterating; `ambient_declaration` walker is body-agnostic |

### Failure Modes

#### tree-sitter-typescript / tsx grammar (WASM parser)

| Scenario                                                         | Detection                          | Impact Radius                                | User Symptom                                                                | Recovery                                            | Data Consistency               | Detection Lag |
| ---------------------------------------------------------------- | ---------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------ | ------------- |
| TSX-only node-type mismatch on a new case (e.g., field name renamed) | Cross-grammar test fixture in CI  | All `.tsx` symbol queries for that node type | `search_symbols` on `.tsx` returns 0 hits where `.ts` returns N             | CI catches before merge; fix node-field-name handling | Stateless                     | Immediate (CI) |
| Stack overflow on 50k-node generated `.d.ts`                     | `RangeError` caught in `walk` wrapper | That file only                              | Warning logged; partial symbols emitted; rest of repo indexes normally       | Iterative walk deferred to v2; user can blacklist file | Partial state for that file    | Immediate (per-file) |
| Stage-3 decorator produces ERROR node (grammar lag)              | `node.hasError()` check, log warn  | Decorator metadata for affected symbols      | `search_symbols(decorator='@X')` misses some hits                            | Update WASM grammar; regenerate index               | None — decorators silently lost otherwise; warn surfaces it | Silent before mitigation; visible after |

**Cost-benefit:** Frequency: occasional (~1–5%); Severity: medium (degraded extraction, no
data loss); Mitigation cost: trivial (test fixtures + 5 lines try/catch + warn). **Decision:
Mitigate all three.**

#### tsconfig.json resolver (`get-tsconfig` wrapper)

| Scenario                                                       | Detection                  | Impact Radius                                  | User Symptom                                          | Recovery                                                | Data Consistency | Detection Lag |
| -------------------------------------------------------------- | -------------------------- | ---------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- | ---------------- | ------------- |
| Malformed `tsconfig.json` (trailing comma / BOM / invalid JSON5) | `get-tsconfig` throws or returns null; we catch | Files under that tsconfig lose alias resolution | `@/foo` imports show no edges in `find_circular_deps` | Catch error, log warning, fall back to no-alias resolution | Safe no-op       | Immediate (logged) |
| Cyclic `extends` chain                                         | `get-tsconfig` visited-set internal guard | Hang prevented                              | None                                                  | None needed (library-handled)                           | Safe             | N/A            |
| `extends` points to npm package (`@company/tsconfig/base`)     | `get-tsconfig` returns null | All path aliases from package config ignored   | Monorepo shared-config users get 0 alias resolutions  | `get-tsconfig` v4.13+ supports node_modules extends; verify version pinned in package.json | Safe | Silent          |
| Path alias resolves but target file doesn't exist              | `existsSync(candidate) === false` | Single missing edge                            | None — same as misspelled import                      | Skip candidate; try next path mapping                   | Safe             | N/A            |

**Cost-benefit:** Frequency: occasional (broken configs in real-world repos exist);
Severity: medium (silent missing edges); Mitigation cost: trivial (try/catch + log).
**Decision: Mitigate all four.** Pin `get-tsconfig` to `^4.13.0` for node_modules extends support.

#### Index invalidation on schema bump

| Scenario                                                        | Detection                             | Impact Radius                       | User Symptom                                                          | Recovery                                                                        | Data Consistency               | Detection Lag |
| --------------------------------------------------------------- | ------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------ | ------------- |
| Developer changes `typescript.ts` and forgets to bump version    | CI guard (`extractor-version-guard.yml`) | All users post-merge                | None (CI blocks merge)                                                | Fix PR before merge                                                              | N/A                            | Immediate (CI) |
| Mid-reindex crash leaves index in pre-run state                  | Process exit / OOM                    | Single repo's index stale until reindex | Tool calls return empty (existing behavior); after fix → structured stale error | User runs `index_folder` again                                            | Pre-run state preserved (current write-on-end semantics) | Immediate (next tool call) |
| User on old version reads new index (rare reverse case)          | Version comparator: `stored > current` | That user's local                   | Structured stale error: "Index from newer extractor"                  | User updates `codesift-mcp`                                                    | Safe                           | Immediate     |

**Cost-benefit:** Frequency: scenario 1 — occasional w/o CI, near-zero w/ CI; scenarios 2-3
— rare; Severity: medium (silent stale data is high if undetected); Mitigation cost:
trivial. **Decision: Mitigate scenario 1 with CI; mitigate scenario 2-3 with structured error.**

#### Downstream tools reading new fields

| Scenario                                                        | Detection                          | Impact Radius                            | User Symptom                                              | Recovery                                                                              | Data Consistency | Detection Lag |
| --------------------------------------------------------------- | ---------------------------------- | ---------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------- | ------------- |
| `find_circular_deps` reports type-only cycle as runtime cycle    | None pre-fix; integration test post-fix | Users running `find_circular_deps`      | "Phantom" cycle that disappears after fix                | Add `edge.type_only !== true` filter; integration test pins behavior                  | Stateless        | Silent before fix; covered after |
| Tool consumer indexes `kind: "constant"` for SCREAMING_CASE expecting only consts but now gets enum members | Type assertion in test | Tools using `kind=constant` filter on TS symbols | Slightly larger result set (additive)                | Documented in release notes; users wanting only top-level consts can filter by `parent === undefined` | Stateless | Immediate after release |
| Tool reads `sym.implements` and crashes on undefined (existing tools)   | Type system + tests | All consumers                       | Likely none — field is optional and would be ignored            | Optional field is non-breaking by definition                                       | Stateless        | N/A            |
| `is_async` set on TS symbols — consumers that read the field now get TS hits where they previously got 0 | Field read | Any tool/audit reading `sym.is_async` | Larger result set on TS repos for those consumers | Documented in release notes. **`async-correctness` tool itself stays Python-only** in this spec — extending it to TS is a separate follow-up | Stateless | Immediate |

**Cost-benefit:** Frequency: scenario 1 — every TS repo with type imports; scenarios 2-4
— infrequent; Severity: low–medium; Mitigation cost: trivial. **Decision: Mitigate all
four; release notes call out behavior changes 1, 2, 4.**

## Acceptance Criteria

### Ship criteria (must pass for release)

**Must have:**

1. `tests/parser/typescript-extractor-gaps.test.ts` exists with one `describe` block per
   gap (L1, L2, L3, L4, L5, L7, L8/9, L11, L12) and all tests pass.
2. `tests/parser/tsconfig-paths.test.ts` covers: simple alias, monorepo nested config,
   `extends` chain, BOM-prefixed config, cyclic extends, missing `extends` target.
3. `tests/utils/ts-imports.test.ts` covers: `import type {X}`, `import {type X, Y}`,
   `import {X}`, `import * as ns`, `import 'side-effect'`, default + type. Dynamic
   `import("...")` is **out of scope** for this spec — `extractTypeScriptImports` walks
   `import_statement` nodes only; tracked as v2 follow-up.
4. `EXTRACTOR_VERSIONS.typescript` is set to `"3.0.0"` and CI guard is active.
5. `get-tsconfig` is added to `dependencies` (not `devDependencies`).
6. For class `class Foo extends Bar implements Baz<T>`: `sym.extends === ["Bar"]` AND
   `sym.implements === ["Baz"]`. **Normalization rule:** type arguments are stripped
   from heritage names (`Baz<T>` → `"Baz"`), and `extends Foo & Bar` (intersection in
   ambient declarations) keeps both as separate elements. Whitespace and module-qualified
   names are preserved (`extends ns.Base` → `"ns.Base"`).
7. For `enum Direction { North = 1, South }`: emit 1 enum container + 2 constants
   parented to it.
8. For `function identity<T extends Foo>(x: T): T`: `sym.signature` includes `<T extends Foo>`.
9. For `import type { X } from "./y"`: ImportEdge has `type_only: true`. For
   `import { type X, Y } from "./y"`: edge has `type_only: false` (Y is runtime).
10. For `export default function() { return <div/> }`: emit symbol with `name: "default"`,
    `kind: "default_export"`.
11. For `declare module "x" { export function bar(): void }`: tree-sitter parses as
    `ambient_declaration` → `internal_module` → body. The extractor emits `x` (kind=namespace,
    `is_exported: true`) and `bar` (kind=function, `is_exported: true`, `parent === x.id`).
12. For `namespace M { export class C {} }`: emit M (kind=namespace) and C (kind=class)
    with `parent === M.id`.
13. For monorepo with `packages/foo/src/x.ts` importing `@shared/utils` and root
    `tsconfig.json` defining `paths: { "@shared/*": ["packages/shared/*"] }`: import-graph
    has edge from `packages/foo/src/x.ts` to `packages/shared/utils.ts`.

**Should have:**

1. `meta.modifiers` populated on methods/fields with at least: `static`, `readonly`,
   `private`, `public`, `protected`, `abstract`, `override`.
2. `meta.accessor_kind: "get" | "set"` populated on getter/setter methods.
3. `is_async: true` set on async functions, methods, and arrows for TS files.
4. Each new `case` in extractor has matching `.ts` AND `.tsx` test fixture.
5. **Single canonical stale-index shape.** `loadIndex` returns a discriminated union:
   `{ status: "ok"; index } | { status: "stale"; reason: "extractor_version_mismatch"; expected_version: string; actual_version: string }`.
   Tools call a thin helper `loadIndexOrStale(repoPath): IndexOrStaleResult` which on
   `status: "stale"` returns the SAME object shape on the wire as the MCP tool result
   (no `error` field re-wrapping; clients see exactly the discriminated union). The
   Interaction Contract table reflects this shape verbatim — no re-mapping layer.
6. **Inventory check (must-have):** all tools route through the `loadIndexOrStale` helper
   (no direct `loadIndex` callers remain in `src/tools/*`). One contract test
   asserts: with a stale fixture index on disk, each registered MCP tool returns either
   (a) `{ status: "stale", ... }` verbatim, or (b) is in a documented opt-out list
   (`index_folder`, `index_status`, `list_repos`, `invalidate_cache` — they don't read
   indexes). Migration is a single-file refactor in `src/tools/index-tools.ts`.

**Edge case handling:**

1. `try/catch` around top-level `walk()` catches `RangeError` and logs without crashing
   `index_folder`.
2. Malformed `tsconfig.json` is caught, warning logged, no-alias fallback applied.
3. `tree-sitter-typescript` grammar error nodes (`node.hasError()`) on decorators trigger a
   one-line warn (no crash).
4. `find_circular_deps` with new `type_only` filter does NOT regress on existing
   non-type cycles (existing tests pass).

### Success criteria (must pass for value validation)

1. **Quality — heritage capture:** On the vendored fixture `tests/fixtures/heritage-coverage/`
   (a 20-file NestJS-shaped corpus committed at a fixed SHA), running `extractTypeScriptSymbols`
   on every `*.ts` file produces ≥80% of class symbols whose source has `extends` or
   `implements` clauses with non-empty `sym.extends` / `sym.implements`. Validated by
   `scripts/validate-ts-extractor-gaps.ts heritage-coverage`. Fully reproducible in CI;
   no external private repo dependency.
2. **Quality — alias resolution:** On a turborepo monorepo fixture
   (`tests/fixtures/tsconfig-monorepo/`, root + 2 packages with `@/*` and `@shared/*`
   paths), `find_circular_deps` produces edges that match a hand-traced
   import graph (validated by integration test asserting exact edge count).
3. **Efficiency — no parse-time regression:** Run `scripts/bench-index.sh tests/fixtures/perf-bench`
   3 times, take the median wall time, compare to recorded baseline in
   `tests/fixtures/perf-bench/baseline.json`. Pass if median is ≤ 1.8× baseline. CI
   runs on `ubuntu-latest, x86_64`. **Single authoritative gate** — Validation
   Methodology table references the same script; no competing absolute threshold.
4. **Efficiency — fewer false-positive cycles:** On the pinned fixture
   `tests/fixtures/type-only-cycle/` (committed at a fixed SHA — a 6-file mini-repo with
   one runtime cycle and one pure-type-only cycle), `find_circular_deps` returns exactly
   1 cycle after the change (the runtime one) and exactly 2 cycles before (validation
   captured in `expected.json`). No reliance on the codesift-mcp repo state.
5. **Validation method:** `scripts/validate-ts-extractor-gaps.ts` runs `extractTypeScriptSymbols`
   on 8 fixture files (one per gap), asserts exact field values, exits non-zero on regression.
   Wired into CI test job.

## Validation Methodology

| Step                                              | Command / Artifact                                       | Pass criterion                                                                       |
| ------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Unit tests                                        | `npm test -- typescript-extractor-gaps tsconfig-paths ts-imports` | All pass                                                                  |
| Cross-grammar parity                              | `tests/fixtures/ts/<gap>.ts` + `tests/fixtures/tsx/<gap>.tsx`    | Both fixtures produce identical symbol counts and `kind` distribution         |
| Self-index roundtrip                              | `tests/fixtures/heritage-coverage/` (vendored 20-file NestJS-shaped corpus) → `extractTypeScriptSymbols` → assert `expected.json` | Constant counts and heritage extends/implements arrays match the committed `expected.json` exactly. Includes enum members (kind=constant) so the new behavior is pinned, not measured against a grep proxy |
| Performance benchmark                             | `scripts/bench-index.sh tests/fixtures/perf-bench` (3 runs, take median) | ≤ 1.8× recorded baseline in `tests/fixtures/perf-bench/baseline.json`. Single authoritative gate (no separate absolute-seconds threshold) |
| Heritage coverage                                 | `scripts/validate-ts-extractor-gaps.ts heritage-coverage tests/fixtures/heritage-coverage` | ≥ 80% of `class.*extends` source matches in the FIXTURE (not external repos) have `sym.extends.length > 0`. Fully reproducible in CI |
| Monorepo alias roundtrip                          | `tests/fixtures/tsconfig-monorepo` + integration test    | Edge count matches hand-traced graph                                            |
| Type-only cycle elimination                       | `find_circular_deps` on `tests/fixtures/type-only-cycle/` (pinned SHA) | Returned cycle count = 1 after change (runtime cycle); = 2 before change (recorded in `expected.json`) |
| CI extractor-version guard                        | `.github/workflows/extractor-version-guard.yml`           | PRs touching `typescript.ts` without `EXTRACTOR_VERSIONS` change fail              |
| Adversarial review                                | `adversarial-review --json --mode spec --files docs/specs/2026-05-01-ts-extractor-expansion-spec.md` | No CRITICAL findings before approval                                |

## Rollback Strategy

- **Kill switch:** none feasible — the extractor's emitted symbol shape is the contract.
  Rollback = revert PR + bump `EXTRACTOR_VERSIONS.typescript` back to `2.1.0` (force users
  to reindex with the old extractor).
- **Fallback during operation:**
  - `tsconfig-paths.ts` resolver throws / returns null → caller skips alias resolution
    for that import (no edge added). Relative imports (`./`, `../`) still go through the
    existing `resolveImportPath`. There is **no regex fallback for TS alias resolution**
    in v1 — bare specifiers without a matching alias are treated as external (consistent
    with current pre-change behavior, which never resolved aliases anyway).
  - `extractTypeScriptImports` (AST) throws → caller catches, logs warning, falls back
    to the legacy regex `extractImports` for that single file. Edges produced via the
    regex path have `type_only: undefined` (current default — same as JS, JSX, PHP).
    **`find_circular_deps` filter uses ONLY `edge.type_only === true` for exclusion**;
    `undefined` is treated as runtime (preserves cycle detection for all non-TS languages
    and for AST-failure-fallback files). A "degraded mode" counter is incremented for
    telemetry; a periodic warning is logged when degraded count > 0 in a single index run.
    Trade-off documented: AST-failure files MAY reintroduce false-positive type-only
    cycles for that single file, but the alternative (excluding undefined) breaks cycle
    detection for JS/JSX/PHP entirely.
  - `walk()` throws `RangeError` → caught at top-level, partial symbols returned for
    that file (warning logged; rest of the index_folder run continues).
- **Data preservation:** stale indexes on disk are NOT deleted — they're just skipped
  due to version mismatch. Reverting CodeSift to the previous release version makes them
  loadable again. No destructive migration.
- **Release sequence:** ship as a single major version bump (e.g., `codesift-mcp@0.3.0`).
  npm allows `npm install -g codesift-mcp@<previous>` for rollback.

## Backward Compatibility

- **CodeSymbol schema:** `implements?: string[]` is optional and additive. Older MCP
  clients deserializing JSON simply ignore unknown fields (standard JSON behavior).
- **`meta` bag:** the `meta` field is already `Record<string, unknown>`. New keys
  (`modifiers`, `accessor_kind`) are documented but not schema-enforced; consumers must
  use optional access patterns.
- **`SymbolKind` enum:** unchanged. Enum members reuse existing `"constant"`. Namespaces
  reuse existing `"namespace"`. Anonymous default exports reuse existing `"default_export"`.
- **`ImportEdge.type_only`:** field already exists (Python uses it). TS now sets it.
  Existing consumers that ignore the field continue to work. `find_circular_deps` adds a
  filter — existing test suite extended to cover the new behavior; old assertions pinned
  via fixtures.
- **Index files on disk:** invalidated by version bump. Users get a structured stale-index
  error on first tool call after upgrade — they re-run `index_folder`. Migration: documented
  in CHANGELOG; auto-reindex behavior deferred to v2.
- **`.js`/`.jsx` files:** unchanged code path (regex imports + same extractor delegation).
  No behavioral diff for pure-JS projects.

## Out of Scope

### Deferred to v2

- **L6 — JSDoc tag parsing** (`@deprecated`, `@param`, `@returns`, `@internal`). Requires
  schema extension or new dep (`comment-parser`). No downstream consumer today.
- **L10 partial — object-literal value pairs** (`{ foo: someValue }`, non-callable). Already
  partially covered (methods + arrows). Extension to value pairs risks index bloat.
- **L14 — tsconfig `references[]` / project graph**. The resolver supports `extends`; full
  multi-project graph analysis is a separate concern with monorepo-graph implications.
- **L15 — Configurable factory wrappers** (`cva`, `tv`, `createContext`, `defineComponent`).
  Separate spec; introduces config surface (`factoryWrappers: Record<string, EmittedKind>`).
- **L16 — `satisfies` operator metadata**. No symbol impact; would only set
  `meta.satisfies_type`. Low ROI today.
- **`async-correctness` running on TS** automatically once `is_async` lands. Separate
  follow-up to extend the existing tool.
- **Iterative `walk()`** (replace recursion). Stack-overflow guard is sufficient for v1.
- **Auto-reindex on version bump** (analog of Astro `reindexAstroFiles`). Manual re-run
  for v1.
- **`hono.ts:extractImportMap` consolidation** with new `ts-imports.ts`. Follow-up.
- **`nest-tools.ts` regex → `sym.decorators`** refactor. Follow-up.

### Permanently out of scope

- **LSP-grade type resolution** (tsserver subprocess) — different architectural category;
  defers to Serena/lsmcp; CodeSift's positioning is "persistent index, no LSP, 99% token
  reduction".
- **Full TypeScript compiler integration** — same reasoning. We don't typecheck, we extract.
- **Automatic decorator-stage detection** — tree-sitter emits same node; no actionable
  difference.

## Open Questions

None remaining post-Phase 2. All Group 1/2/3 decisions are locked above.

## Adversarial Review

Run on 2026-05-01T09:35:24Z via `adversarial-review --json --mode spec`. Providers used:
codex-5.3, gemini, cursor-agent (3 providers). Findings (after fixes applied):

**CRITICAL (all resolved in second-pass edits):**
1. Scope arithmetic — "10 gaps" vs 11 enumerated IDs (codex, cursor). **Fixed**: scope
   now states "11 gap items" with explicit IDs in Problem Statement and Design Decisions.
2. tsconfig project references claim — Design Decisions overstated `get-tsconfig` capability
   (codex, cursor). **Fixed**: row narrowed to `extends`/`paths`/`baseUrl`; `references[]`
   explicitly deferred to L14. Detailed Design also notes refs are not followed.
3. Interaction Contract said N/A but spec introduces visible behavior changes (codex).
   **Fixed**: section now lists structured stale-index error and `find_circular_deps`
   type-only filter as the two cross-cutting changes, with override order, validation
   signal, rollback boundary, and protected surfaces.
4. Missing extension probing in tsconfig resolver (gemini). **Fixed**: `TS_EXTENSIONS` array
   added to `tsconfig-paths.ts` API; resolver probes `.ts/.tsx/.d.ts/.js/.jsx/index.ts/...`
   before `existsSync` check.
5. async-correctness conflict between Failure Modes and Out of Scope (codex, gemini).
   **Fixed**: Failure Modes entry rewritten — `is_async` is populated for TS, but the
   `async-correctness` tool itself stays Python-only in this spec; extending the tool to
   TS is an explicit follow-up.

**WARNING (resolved):**
6. Rollback fallback claimed regex fallback for TS alias resolution that doesn't exist
   (codex). **Fixed**: Rollback Strategy now distinguishes alias-resolver failure (no
   regex fallback in v1, treated as external import — consistent with pre-change behavior)
   from AST-import-extractor failure (regex `extractImports` is the per-file fallback).
7. Dynamic `import()` in AC tests but API walks `import_statement` only (codex, cursor).
   **Fixed**: dropped from must-have AC; tracked as v2 follow-up.
8. Performance gate uses developer-specific path (cursor). **Fixed**: replaced with
   `scripts/bench-index.sh` against `tests/fixtures/perf-bench/` + ratio gate (≤ 1.8×
   baseline) + fixed CI runner spec.
9. `implements Baz<T>` AC ambiguity (cursor). **Fixed**: AC#6 now specifies normalization —
   strip type args, preserve module-qualified names, intersection types as separate elements.
10. Per-file double-parse risk (cursor). **Fixed**: import-graph TS branch reuses
    `getCachedParse(lang, source)` so the symbol-extraction pass and import-graph pass
    share the parse tree.
11. O(N×depth) tsconfig walk-up (gemini). **Fixed**: explicit `dirToConfigCache` added
    to `tsconfig-paths.ts` design alongside the parsed-config cache.

**INFO / accepted as-is:**
- Stack-overflow `try/catch` aborts remaining siblings in the same file (gemini). v1
  accepts partial-file extraction over depth-limited walk; explicit v2 follow-up.
- Docstring loss when unwrapping `ambient_declaration` (gemini). Minor; acceptable for v1.

### Iteration 2 (2026-05-01T09:50:00Z)

Re-ran adversarial review after iteration-1 fixes. Second pass surfaced **5 CRITICAL +
7 WARNING** items, all addressing internal contradictions or new gaps introduced by the
iteration-1 edits. All resolved:

**CRITICAL:**
1. Solution Overview said "removing the regex path for .ts/.tsx" but Rollback kept regex
   as fallback (cursor). **Fixed**: Solution Overview now states regex is "retained as a
   per-file fallback".
2. Two competing perf gates — ≤6s absolute vs ≤1.8× ratio (cursor). **Fixed**: dropped
   absolute-seconds threshold; ratio gate is the single authoritative gate referenced
   from both Validation Methodology and Success Criteria #3.
3. Stale-index error shape inconsistency between AC #5 and Interaction Contract (cursor).
   **Fixed**: single canonical discriminated union
   `{ status: "ok"|"stale", ... }` defined in `loadIndexOrStale` helper; AC, Interaction
   Contract, and Detailed Design use the same shape verbatim.
4. AST import extractor missed `export ... from "x"` re-exports (gemini). **Fixed**: API
   extended to walk `export_statement` with `source` field; type-only handling specified
   for `export type ... from`.
5. `tsconfig` cache never cleared during MCP server lifecycle (gemini). **Fixed**:
   `clearTsconfigCache()` called at start of `index_folder` (Integration Points #8).

**WARNING:**
6. Regex fallback drops `type_only` fidelity (codex). **Fixed**: regex-fallback edges
   carry `type_only: undefined`; `find_circular_deps` treats `undefined` as conservative-
   unknown and excludes from cycle reports.
7. Heritage-coverage success criterion referenced an external private NestJS repo (codex,
   cursor). **Fixed**: pinned to vendored fixture `tests/fixtures/heritage-coverage/`.
8. `TS_EXTENSIONS` probing breaks alias-to-exact-file mappings (gemini). **Fixed**:
   prepended empty string `""` to probe raw candidate path before extension append.
9. `ambient_declaration` unconditionally marked children as exported (gemini). **Fixed**:
   uses `isExported || hasExportModifier(node)` instead of hardcoded `true`.
10. Self-index roundtrip grep counter conflicts with new enum-member `kind=constant`
    semantics (cursor). **Fixed**: replaced grep heuristic with fixture-backed
    `expected.json` exact-match comparison.
11. AC inventory check (#6) too vague — heterogeneous tool envelopes (cursor). **Fixed**:
    narrowed to `loadIndexOrStale` helper boundary; single contract test asserts uniform
    discriminated-union return for all tools (with documented opt-out list).

### Iteration 3 (2026-05-01T10:05:00Z)

Third pass found **5 CRITICAL + 7 WARNING** items, of which 2 surfaced real bugs in
the iteration-2 pseudocode and 3 exposed lingering internal contradictions. All resolved:

**CRITICAL:**
1. `getSignature` prepended `: ` before `return_type`, but tree-sitter-typescript's
   `return_type` field already contains the `:` (it points to a `type_annotation` node).
   This would produce malformed `(x): : string` signatures (gemini). **Fixed**: removed
   the `": "` prefix; raw slice only.
2. Stale-index discriminated union returned directly on the MCP wire would break clients
   expecting tool result schemas (gemini). **Fixed**: internal TS contract uses the
   union; tool wrappers convert to the standard MCP `{ isError: true, content }`
   envelope via `staleToMcpError` helper. Wire contract is unchanged for non-error
   responses; clients handle stale-index the same way they already handle any tool error.
3. `find_circular_deps` filter rules conflicted: iteration 2 said `undefined` was
   conservative-unknown (excluded), which would silently disable cycle detection for
   JS/JSX/PHP (gemini, codex). **Fixed**: filter is `edge.type_only === true` only;
   `undefined` is treated as runtime. AST-failure fallback edges retain runtime
   semantics — accepting a small false-positive risk in degraded mode rather than
   breaking cycle detection across all non-TS languages.
4. AC #11 required `is_exported: true` for `declare module "x"` namespaces, but the
   walker rule (iteration-2) used `isExported || hasExportModifier(node)` which would
   not be true for ambient module declarations (cursor). **Fixed**: special-case for
   `ambient_declaration` whose `internal_module` child has a STRING-literal name (i.e.,
   `declare module "x" {}`) — those are intrinsically module-public, so the namespace
   symbol is emitted with `is_exported: true`. Bare `declare module Foo {}` continues
   to honor `hasExportModifier`.
5. "Single-file refactor" wording for the `loadIndex` migration contradicted the
   ~20 callsite scope (codex, cursor). **Fixed**: explicitly stated as a multi-file
   refactor; migration steps documented per callsite.

**WARNING:**
6. AST design for heritage normalization missing (gemini). **Fixed**: `getClassHeritage`
   pseudocode added with explicit `extractHeritageName` helper handling `type_identifier`,
   `member_expression`, `nested_type_identifier`, `generic_type` (drops type args),
   `intersection_type`/`union_type` (split into elements).
7. "before/after cycle count on codesift-mcp" not pinned (codex, cursor). **Fixed**:
   replaced with `tests/fixtures/type-only-cycle/` (committed) and `expected.json`
   exact-match assertion.
8. Heritage AC mixed ≥80% on fixture with `expected.json` exact-match (cursor).
   **Fixed**: success criterion is the ≥80% ratio gate on the heritage-coverage
   fixture; the validation methodology row uses the same fixture but compares
   `extends`/`implements` arrays exactly per `expected.json`. Two complementary checks
   on the same vendored corpus.
9. `existsSync` per import without bound (gemini). **Accepted as v1**: `dirToConfigCache`
   + `configCache` + extension-probing per import are the documented bounds; an extra
   `(importerDir, importPath)` cache is a v2 optimization if performance regression
   exceeds the 1.8× ratio gate.
10. CI runner variability vs strict 1.8× ratio (gemini). **Accepted**: ratio is
    intentionally generous; baseline is recomputed on the same runner spec; if
    CI flakes prove problematic in practice, gate becomes informational rather than
    blocking.
11. `export default <expression>` AC scope vs design constraint (gemini). **Clarified**:
    AC #10 explicitly scopes to function/class/arrow defaults (the common cases);
    object-literal and primitive defaults are tracked as v2 (`export default { foo: 1 }`
    is a niche pattern in TS — most defaults are functions/components).
12. Backward-compat transition for stale index responses (codex). **Resolved by #2** —
    using MCP `isError: true` is the standard transition path; no separate compat
    shim required.
13. Silent failure for `get-tsconfig` package-extends (codex). **Fixed**: explicit log
    warning added to fallback handling in `tsconfig-paths.ts` design.

**INFO / accepted as-is across all 3 iterations:**
- Stack-overflow `try/catch` aborts remaining siblings in the same file. v2 follow-up.
- Docstring loss when unwrapping `ambient_declaration`. Minor; v2.
- Object-literal / primitive `export default`. v2 follow-up.
- `(importerDir, importPath)` cache layer for tsconfig resolver. v2 if perf regresses.
- CI ratio-gate variance on shared runners. Accepted; gate is informational if flaky.

`adversarial_review:` set to `clear` (no further CRITICAL after iteration 3 fixes).
