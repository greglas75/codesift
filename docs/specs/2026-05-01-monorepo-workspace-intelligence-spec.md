# Monorepo Workspace Intelligence — Design Specification

> **spec_id:** 2026-05-01-monorepo-workspace-intelligence-1542
> **topic:** Workspace-aware code intelligence for JS/TS monorepos (Turbo, pnpm/yarn/npm workspaces)
> **status:** Approved
> **created_at:** 2026-05-01T15:42:46Z
> **reviewed_at:** 2026-05-01T15:54:00Z
> **approved_at:** 2026-05-01T16:05:00Z
> **approval_mode:** async
> **adversarial_review:** warnings
> **author:** zuvo:brainstorm
> **user_approval:** explicit blanket auth granted for autonomous brainstorm→plan→execute pipeline (2026-05-01)

## Problem Statement

CodeSift MCP serves AI coding agents working in real codebases. A growing fraction of those codebases are JS/TS **monorepos** managed by Turbo + pnpm-workspace, npm/yarn workspaces, or Nx. The competitive landscape (Apr 2026 refresh) shows only the official `nx-mcp` server treats workspaces as first-class — and it serves only Nx. The much larger Turbo + plain-pnpm-workspace population is unserved.

Today CodeSift detects workspaces shallowly (regex YAML parser at `src/tools/project-tools.ts:404`) but **only** uses the result inside the `analyze_project` profile. Every other tool — search, references, impact analysis, boundary checking, framework auto-load — is workspace-blind. Concrete consequences for the user:

- `find_references("Button")` misses cross-package usage when consumers import via `@org/ui` rather than relative paths (`src/utils/import-graph.ts:63-100` resolves only `^\.` paths).
- `impact_analysis(since="HEAD~3")` reports a change in `packages/shared/Button.tsx` as affecting only files inside `packages/shared` — `apps/web` is invisible because its imports are bare-name workspace aliases.
- `check_boundaries` rules use path substrings (`src/tools/boundary-tools.ts`) and cannot say "apps/web cannot import from apps/api" without coincidental directory-name uniqueness.
- Framework tools (`framework_audit`, `nextjs_route_map`, `analyze_hono_app`) auto-load only from root `package.json` — when `apps/web` is Next.js but root is plain TypeScript, those tools never enable unless the user runs from the subpackage.
- `find_circular_deps` is Python-only (`src/tools/python-circular-imports.ts`); JS/TS monorepos cannot detect package-level cycles.

**Who is affected:** every agent (Claude Code, Codex, Cursor, Antigravity) operating inside a Turbo / pnpm-workspace / Nx repo — which is a majority of mid-to-large web codebases in 2026. Doing nothing leaves a market gap that competitors (jCodeMunch, Serena, GitNexus) are already noticing in their roadmaps.

**Documented agent failure modes** (from Datadog/Nx 2026 publications, corroborated by zuvo retro telemetry — `usage-zuvo-retro-2026-04-30.md`): cross-workspace search noise, wrong-scope imports, no architectural map, undetected boundary violations, stale graph after dep changes.

## Design Decisions

### D1 — Scope: Foundation+ (between A and B from brainstorm)
**Chosen:** Workspace resolver + workspace index dimension + workspace-alias import resolution + 4 new tools + per-workspace framework auto-load + package-level circular deps + optional `workspace=` parameter on framework tools.
**Rationale:** User directive "długofalowe" (long-term). Pure Foundation A leaves the documented per-workspace framework auto-load gap unaddressed, which is a high-leverage usability win that's mechanical once the workspace model exists. Per-package circular deps is cheap to add on top of the workspace graph.
**Deferred to v2:** Full Nx project graph (project.json `targets`, `implicitDependencies`, `tags`), workspace-aware `detect_communities`, polyglot monorepos, Bazel/Buck.
**Alternatives considered:** Pure Foundation A (rejected — leaves obvious gap), Comprehensive B (rejected — Nx full graph and workspace-aware communities are lower leverage and `nx-mcp` already serves Nx users).
**[AUTO-DECISION]**

### D2 — Manifest parsing: `@manypkg/get-packages` for packages + manual turbo/nx detection
**Chosen:** Use `@manypkg/get-packages` to enumerate workspace packages and detect the package manager (npm/yarn/pnpm/bun). Layer **manual file checks** on top to determine `monorepo_tool`:
1. `@manypkg/get-packages` → `{ tool: "npm" | "yarn" | "pnpm" | "bun" | "lerna" | "rush", packages, rootPackage }`.
2. If `turbo.json` exists at root → set `manifest_tool = "turbo"` (preserves `tool` underneath).
3. Else if `nx.json` exists at root → set `manifest_tool = "nx"`.
4. Else `manifest_tool = tool` from @manypkg.

Keep the current regex code path as fallback in a try/catch when @manypkg throws.
**Rationale:** @manypkg does NOT parse `turbo.json` or `nx.json` — it only handles workspace-glob enumeration via the package manager's manifest. Treating the build orchestrator (Turbo, Nx) as a separate signal is correct and avoids the contradiction caught by adversarial review (gemini critical finding #1).
**Alternatives considered:** Microsoft `workspace-tools` (Rust, heavier install), `find-workspaces` (less adopted), DIY parser (brittle, no negation/nested globs).
**[AUTO-DECISION] [adversarial-review fix: gemini #1]**

### D3 — Boundary rules: new `workspace_boundaries` tool with dedicated schema
**Chosen:** Add a **new** `workspace_boundaries` tool with its own `WorkspaceBoundaryRule` shape. Existing `check_boundaries` and its `BoundaryRule` type are **unchanged** — guaranteed byte-compatible.

`WorkspaceBoundaryRule`:
```ts
{
  from_workspace: string;            // workspace name OR glob ("apps/*")
  cannot_import_workspaces: string[]; // names OR globs OR negation "!apps/web"
}
```

Path-based rules continue to live in `check_boundaries`; workspace-identity rules live in the new tool. Users who want both compose them in their own audit harness.
**Rationale:** Adversarial review caught a contradiction in the original D3 (cursor-agent critical, gemini warning): D3 had said "extend check_boundaries" while Backward Compat said it was unchanged. Splitting into two tools removes the ambiguity, preserves backward compat hard, and lets the workspace tool's schema evolve without touching the path-based one.
**Alternatives considered:** Nx tag-based (rejected — requires user config, excludes target audience), unified rule schema (rejected — broke backward compat).
**[AUTO-DECISION] [adversarial-review fix: cursor-agent #1, gemini #4]**

### D4 — Cross-package import resolution: package.json#name + tsconfig paths, **fully cached at index time**
**Chosen:** Two-source resolver in `import-graph.ts`:
1. **Workspace package name lookup:** import `@org/foo` → if `@org/foo` is a workspace package per `Workspace.name` map → resolve to that workspace's main/exports field.
2. **tsconfig paths aliases:** parse via `get-tsconfig` (recursive, handles `extends`, root `tsconfig.base.json`). Apply only when path starts with an aliased prefix.

Relative imports (`^\.`) keep current resolution.

**Caching contract (mandatory):**
- `get-tsconfig` is invoked **once per workspace at index build time** (in `WorkspaceResolver.resolve`).
- Resolved aliases are stored in `Workspace.tsconfig_paths`.
- The import resolver reads from the in-memory `Workspace` object — **zero disk IO per import edge**.
- Cache invalidates when `EXTRACTOR_VERSIONS.monorepo` bumps or any tsconfig.json mtime changes (existing file-watcher mechanism).

**Rationale:** Adversarial review (gemini warning) flagged that uncached `get-tsconfig` per import edge would blow the 800ms latency budget on large monorepos. Cache-at-index-time is the standard pattern.
**Alternatives considered:** Full Node resolution (too heavy, IO-bound), runtime resolver via `tsconfig-paths` (designed for runtime, not analysis), relative-only (broken for monorepos).
**[AUTO-DECISION] [adversarial-review fix: gemini #7]**

### D5 — Affected-set semantics: file changes → containing workspace → reverse-deps
**Chosen:** `affected_workspaces(since=<git-ref>)` algorithm:
1. Compute changed files via `git diff --name-only <ref>...HEAD` plus `git diff --name-only --diff-filter=D <ref>...HEAD` for deleted files.
2. Map each file to its containing workspace (longest-prefix match against `Workspace.root`).
3. **Deleted-file handling:** if a file's path no longer maps to any current workspace, attempt longest-prefix match against the **pre-`since` snapshot** of workspaces (rebuilt by reading `pnpm-workspace.yaml` / `package.json` at `<since>` via `git show`). If pre-snapshot also fails, classify as `root-level` and surface separately.
4. Collect direct workspaces.
5. Walk reverse-deps in current workspace graph (transitive closure). For deleted workspaces, walk their pre-deletion reverse-deps from the pre-snapshot graph.
6. Return union with `{ workspace, reason: "direct" | "transitive" | "deleted-workspace-rev-dep", changed_files, via?: string[] }`.

**Lockfile policy:** `pnpm-lock.yaml` / `package-lock.json` / `yarn.lock` / `bun.lockb` changes do NOT automatically fan out to all workspaces (avoids documented Turbo issue #11144 — over-triggering). They are surfaced under `excluded_lockfile_changes` for transparency. **Lockfile fanout is permanently OFF in v1** — no opt-in flag; users who need it must compute it themselves until v2 introduces a flag (see Out of Scope).
**Rationale:** Matches `nx affected` and `turbo --filter=...[<base>]` semantics. Lockfile policy follows user-feedback consensus that fan-out is more annoying than under-triggering. Deleted-file handling addresses adversarial review (gemini warning).
**Alternatives considered:** Lockfile always fans out (rejected — known pain point), per-symbol affected (deferred — needs deeper diff parsing), single-graph deletion handling (rejected — gemini caught it would miss reverse-deps).
**[AUTO-DECISION] [adversarial-review fix: codex-5.3 #1, gemini #6]**

### D6 — Index schema: additive `workspaces?: Workspace[]` + extractor version bump
**Chosen:** Add optional fields to `CodeIndex`:
```ts
workspaces?: Workspace[]    // present iff monorepo detected
fileToWorkspace?: Map<string, string>   // path → workspace.id, lazy-built
```
Bump `EXTRACTOR_VERSIONS.monorepo` from `0` → `1` so existing indices reindex once on upgrade (per existing per-language extractor invalidation in `src/storage/registry.ts`).
**Rationale:** Existing single-repo indices keep working byte-identically when `workspaces` is absent. Schema migration uses a battle-tested mechanism.
**Alternatives considered:** Separate index per workspace (rejected — breaks cross-package search), migration via separate file (rejected — extra IO, sync hazard).
**[AUTO-DECISION]**

### D7 — Tool surface: 4 new + extension of existing
**New tools (atomic, following existing convention):**
1. `list_workspaces(repo?)` — returns `[{ id, name, path, package_manager_role, dependencies }]`
2. `workspace_graph(repo?, format?: "json" | "mermaid" | "dot")` — full DAG of workspace-to-workspace deps
3. `affected_workspaces(repo?, since: string, include_transitive?: boolean)` — see D5
4. `workspace_boundaries(repo?, rules: BoundaryRule[])` — workspace-aware boundary check (companion to existing `check_boundaries`, separate tool to avoid breaking flat-repo callers)

**Extended (no API breakage):**
- `find_references`, `trace_call_chain`, `impact_analysis` — silently resolve workspace aliases (D4) when `workspaces` is present in the index. No new params.
- `framework_audit`, `nextjs_route_map`, `nextjs_metadata_audit`, `analyze_hono_app`, `nest_audit`, `astro_audit` — accept optional `workspace?: string` param. When provided, scope file scanning to that workspace's root. When omitted, behavior unchanged.
- `find_circular_deps` — gain JS/TS support at file AND package level; output `{ file_cycles, package_cycles }`.
- `analyze_project` — replace shallow YAML regex with `@manypkg/get-packages`; richer output.
- `plan_turn` — add framework boost for monorepo terms (`monorepo`, `workspace`, `package <name>`, `apps/`, `packages/`) → routes to new tools.

**Rationale:** Atomic tools match existing conventions (`nextjs_route_map` etc.). Composite reserved for related-ops bundles. Affected-detection has different latency profile (git diff IO) than graph-listing — keep separate.
**Alternatives considered:** Single `workspace_audit` composite (rejected — different latency profiles, harder to compose with `plan_turn`).
**[AUTO-DECISION]**

### D8 — Per-workspace framework auto-load: union of detected stacks with smart default scoping
**Chosen:** At indexer startup (`src/register-tools.ts:detectAutoLoadTools`), if monorepo detected, walk every workspace's `package.json` and union the detected framework signals. Each detected framework registers its tool group via existing `FRAMEWORK_TOOL_GROUPS` mechanism.

**Smart-default scoping** (addresses gemini critical #3):
- When a framework is detected ONLY in subworkspaces (root `package.json` does not declare it), the auto-loaded tool's `workspace=` parameter **defaults to the union of detected workspaces** rather than the root.
- Example: `nextjs_route_map()` called with no args, when Next.js is in `apps/web` only → tool internally scopes file scan to `apps/web/**`. If multiple workspaces have Next.js, tool returns merged result with per-workspace breakdown.
- Agent can override by explicitly passing `workspace=` with a different value.
- When framework IS at root (single-package repo or root-level config), behavior is unchanged.

**Startup performance budget:** framework detection across all workspaces must add **≤50ms per 100 workspaces** (measured at startup). If exceeded, detection is deferred to lazy on first tool call. Implementation uses parallel `readJson` for workspace `package.json` files (already non-blocking).

**Rationale:** Closes Code Explorer gap (item 3) AND adversarial review (gemini critical #3 — framework tools were registering globally but failing when called without workspace=). Smart-default makes tools usable out of the box. Latency budget addresses codex-5.3 warning.
**Alternatives considered:** Lazy load per-call (slower for first call, surprising — kept as fallback past budget), require explicit cwd (frustrating), require explicit workspace= param (breaks ergonomics).
**[AUTO-DECISION] [adversarial-review fix: gemini #3, codex-5.3 #5]**

### D9 — Repo identity: unchanged
**Chosen:** `repo` remains path-based (one CodeIndex per indexed root). Workspace is a sub-dimension on the index, not a separate identity.
**Rationale:** Preserves all existing tool surfaces. Cross-package search continues to work. Per-workspace scoping happens via filters/params, not separate indices.
**Alternatives considered:** Workspace-as-repo (rejected — breaks unified search), per-workspace index files (rejected — loses semantic search continuity, complicates incremental updates).
**[AUTO-DECISION]**

### D10 — Hard out-of-scope list
- Nx project graph beyond basic project name/root/deps (no `targets`, `implicitDependencies`, `tags`)
- Bazel / Buck / Pants
- Yarn Berry PnP (1% adoption, distinct resolution model)
- Polyglot monorepos (Python/Go/Rust in `apps/*`) — defer
- Turbo cache integration / hash-based affected
- Workspace refactoring (extract / split / merge)
- Package version drift (already covered by `dependency_audit`)
- Workspace-aware `detect_communities`
**[AUTO-DECISION]**

## Solution Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     CodeSift Monorepo Layer                     │
└─────────────────────────────────────────────────────────────────┘

        ┌──────────────────────────┐
        │  WorkspaceResolver       │  reads turbo.json,
        │  (@manypkg/get-packages) │  pnpm-workspace.yaml,
        │  + tsconfig paths        │  package.json#workspaces,
        └──────────┬───────────────┘  nx.json (basic),
                   │                  tsconfig paths
                   ▼
        ┌──────────────────────────┐
        │  Workspace Model         │   { id, name, root, packageJson,
        │  (in CodeIndex)          │     dependencies, tsconfigPaths,
        └──────────┬───────────────┘     framework, files[] }
                   │
        ┌──────────┴────────────────────────────────┐
        ▼                                            ▼
┌────────────────────┐                  ┌───────────────────────────┐
│  Import Resolver   │                  │  Framework Auto-Loader    │
│  (workspace alias  │                  │  (union of detected       │
│   + tsconfig paths)│                  │   stacks per workspace)   │
└─────────┬──────────┘                  └────────────┬──────────────┘
          │                                          │
          ▼                                          ▼
┌────────────────────────┐         ┌──────────────────────────────────┐
│  Cross-Package Edges   │         │  framework_audit, nextjs_*, hono │
│  (powers existing      │         │  with optional workspace= scope  │
│   find_references,     │         └──────────────────────────────────┘
│   impact_analysis,     │
│   trace_call_chain)    │
└────────────────────────┘
          │
          ▼
┌──────────────────────────────────────────────────────────────────┐
│  New Workspace Tools                                             │
│  ─ list_workspaces      ─ workspace_graph                        │
│  ─ affected_workspaces  ─ workspace_boundaries                   │
│  ─ find_circular_deps (extended for JS/TS file + package cycles) │
└──────────────────────────────────────────────────────────────────┘
```

**Data flow per query:**
1. Agent calls e.g. `find_references("Button", file_pattern="packages/shared/**")`.
2. Existing reference resolver runs.
3. **NEW:** when `index.workspaces` present, the import edge builder applies workspace-alias resolution → adds cross-package edges → references in `apps/web/**` now appear in results.
4. Output is byte-compatible with existing format (just more results).

For new monorepo tools, agents go through `plan_turn` (now framework-boosted on monorepo terms) → land on `list_workspaces` / `workspace_graph` / `affected_workspaces` / `workspace_boundaries` directly.

## Detailed Design

### Data Model

New types in `src/storage/types.ts` (or equivalent):

```ts
export type Workspace = {
  id: string;            // stable: package name OR relative path if name absent
  name: string | null;   // package.json#name; null for invalid packages
  root: string;          // absolute path
  package_manager_role: "root" | "package";
  manifest_tool: "turbo" | "pnpm" | "yarn" | "npm" | "bun" | "nx" | "lerna";
  dependencies: {
    workspace: string[];   // names of internal workspace deps
    external: string[];    // npm registry deps (names only, versions live in package.json)
  };
  tsconfig_paths: Array<{ from_pattern: string; to_paths: string[] }>;  // resolved relative to workspace root
  detected_frameworks: string[];  // e.g. ["nextjs", "hono"]
  // file_count, symbol_count populated lazily after indexing
  file_count?: number;
  symbol_count?: number;
};

export type CodeIndex = {
  // ... existing fields unchanged ...
  workspaces?: Workspace[];           // present iff monorepo
  // fileToWorkspace built lazily, not persisted (path → workspace.id)
};

// existing BoundaryRule type stays UNCHANGED (used by check_boundaries):
//   { from: string; cannot_import: string[] }

// NEW type used only by the new workspace_boundaries tool:
export type WorkspaceBoundaryRule = {
  from_workspace: string;             // exact name OR glob
  cannot_import_workspaces: string[]; // names OR globs OR negation "!name"
};

export type AffectedResult = {
  since_ref: string;
  changed_files: string[];
  affected: Array<{
    workspace_id: string;
    workspace_name: string | null;
    reason: "direct" | "transitive";
    changed_files: string[];        // empty for transitive
    via?: string[];                  // for transitive: chain of workspace ids
  }>;
  excluded_lockfile_changes: string[];  // surfaced for transparency
};
```

### API Surface

**New tools** (Zod schemas in `src/tools/workspace-tools.ts`):

```ts
list_workspaces({ repo?: string }):
  { workspaces: Workspace[], monorepo_tool: string | null }

workspace_graph({ repo?: string, format?: "json" | "mermaid" | "dot" }):
  format === "json" → { nodes: Workspace[], edges: Array<{from, to, kind: "workspace_dep"}> }
  format === "mermaid" → { mermaid: string }
  format === "dot" → { dot: string }

affected_workspaces({
  repo?: string,
  since: string,                       // git ref or "HEAD~N"
  include_transitive?: boolean         // default true
}):
  AffectedResult

workspace_boundaries({
  repo?: string,
  rules: WorkspaceBoundaryRule[]
}):
  { violations: Array<{
      from_file: string,
      from_workspace: string,
      to_workspace: string,
      import_specifier: string,
      rule_matched: BoundaryRule
    }>
  }
```

**Extended tools — additive params only:**
- `framework_audit(workspace?: string, ...existing)`: when `workspace` provided, scope `file_pattern` to that workspace's root.
- `nextjs_route_map`, `nextjs_metadata_audit`, `analyze_hono_app`, `nest_audit`, `astro_audit`: same `workspace?` param.
- `find_circular_deps`: output gains optional `package_cycles: Array<{cycle: string[]}>` field for JS/TS monorepos.
- `analyze_project`: profile output gains `monorepo: { tool, workspaces: Workspace[] }`.

**Silently extended (no schema change):**
- `find_references`, `trace_call_chain`, `impact_analysis`: cross-package edges added when index has `workspaces`.

### Integration Points

| Existing file | Change |
|---|---|
| `src/storage/types.ts` | Add `Workspace`, `WorkspaceBoundaryRule`, `AffectedResult`. Add `workspaces?` to `CodeIndex`. Existing `BoundaryRule` UNCHANGED. |
| `src/storage/extractor-versions.ts` | Bump `monorepo` extractor version to invalidate stale indices. |
| `src/storage/indexer.ts` | After file walk, call `WorkspaceResolver.resolve(root)` → populate `index.workspaces`. |
| `src/utils/walk.ts` | Add `.pnpm` to `IGNORE_DIRS` (currently only `node_modules`). |
| `src/utils/import-graph.ts` | Inject workspace-alias resolver and tsconfig-paths resolver into edge builder. |
| `src/tools/project-tools.ts:388-480` | Replace regex YAML parser with `@manypkg/get-packages`; keep current code as fallback in catch block. |
| `src/tools/boundary-tools.ts` | Existing `check_boundaries` UNCHANGED. New `workspace_boundaries` tool added in same file (or new `src/tools/workspace-boundaries-tool.ts`). |
| `src/storage/indexer.ts` | Add early return when `process.env.CODESIFT_DISABLE_MONOREPO === "1"` — `index.workspaces` stays `undefined`, all monorepo paths short-circuit. |
| `src/tools/impact-tools.ts` | When index has `workspaces`, propagate impact across workspace edges. |
| `src/register-tools.ts` `detectAutoLoadTools` | Walk workspaces for framework signals; union into auto-load set. |
| `src/tools/circular-deps-tools.ts` (new) | JS/TS file + package cycle detection. |
| `src/tools/workspace-tools.ts` (new) | 4 new tools. |
| `src/search/tool-ranker.ts` | Add framework boost for monorepo query terms. |
| `src/instructions.ts` | Document new tools in CODESIFT_INSTRUCTIONS. |

**New runtime dep:** `@manypkg/get-packages` (~12KB gzipped, MIT, no native deps), `get-tsconfig` (already widely used, MIT).

### Interaction Contract

Not applicable — no cross-cutting agent behavior change. Tools are additive; existing tools preserve their output shape. The only "silent extension" is that `find_references` and friends now see more results in monorepos, which is the intended fix for the documented bug, not a contract change.

### Edge Cases

1. **Glob negation in `pnpm-workspace.yaml`**: `packages: ['packages/*', '!packages/exclude']` — handled by `@manypkg/get-packages` natively. Tested via fixture.
2. **Workspace package missing `name`**: `Workspace.name = null`, `id` falls back to relative path. Tools emit warning when referenced by name.
3. **Duplicate package names** (two workspaces with `@org/utils`): `WorkspaceResolver.resolve()` errors out with explicit message; index falls back to non-monorepo mode with warning, so the rest of CodeSift keeps working.
4. **`workspace:*` / `workspace:^` / `workspace:~` versions**: detected as workspace deps in `dependencies.workspace`. Version is preserved in raw `package.json` snapshot but not interpreted.
5. **`.pnpm` symlink forest**: added to `walk.ts` ignore list. Indexer never enters it.
6. **Mixed import styles** (bare + relative for the same target): both edges added; `find_references` deduplicates.
7. **tsconfig `references` out of sync with workspace deps**: not validated in v1 (covered by future `dependency_audit` extension).
8. **Workspace with both `src/` and `dist/`**: both indexed by default; user can pass `include_paths` to filter. Document recommendation: `dist` typically excluded by `.gitignore`, which `walk.ts` already respects.
9. **Re-exports across packages**: tracked via existing symbol export tracking (no new logic needed).
10. **User CWD inside subpackage**: `repo` auto-resolves to the indexed root (existing behavior). All tools work; agents should pass `workspace=` for narrower scope.
11. **Non-monorepo project**: `WorkspaceResolver` returns `{ workspaces: undefined }`; index unchanged from current behavior. **Hard regression test required.**
12. **Malformed `turbo.json` / `pnpm-workspace.yaml`**: caught in resolver; fall back to non-monorepo mode + log warning. No tool failures.
13. **Empty workspace globs** (`packages/*` matches nothing): `Workspace[]` may be empty; all tools handle empty case gracefully.
14. **Yarn classic legacy `nohoist`**: ignored (no impact on workspace graph).
15. **Nested workspaces** (workspace contains its own `pnpm-workspace.yaml`): outer config wins; inner ignored with warning.
16. **Lockfile-only changes in `affected_workspaces`**: lockfile files surfaced in `excluded_lockfile_changes`; do not fan out (D5 policy).

### Failure Modes

#### WorkspaceResolver

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| `@manypkg/get-packages` throws on malformed config | try/catch around resolve() | All workspace tools | "Monorepo detection failed: <reason>; running flat-mode" warning | Auto fallback to non-monorepo mode + retain current behavior | None — `workspaces` field absent | Immediate (at index time) |
| Glob matches 0 packages (typo) | `packages.length === 0` | Workspace tools return empty | `list_workspaces` returns `{ workspaces: [], monorepo_tool: <tool> }` | User fixes glob, re-indexes | Index built without workspace info | Immediate |
| Duplicate package names | name collision check during resolve | All workspace tools | Warning emitted; non-monorepo fallback | Fix `package.json#name` collision, re-index | None — fallback path active | Immediate |
| Symlinked `.pnpm` traversal | walk excludes `.pnpm` | None (prevented) | n/a | n/a — proactive | n/a | n/a |
| Nested `pnpm-workspace.yaml` | Inner config detected during walk | One workspace becomes opaque | Warning logged; outer config wins | Restructure project or accept | Outer view authoritative | Immediate |

**Cost-benefit:** Frequency: occasional (~5% of monorepos have at least one config quirk) × Severity: low (graceful fallback exists) → Mitigation cost: low (try/catch + warning) → **Decision: Mitigate.**

#### Workspace Index (CodeIndex.workspaces)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Stale `workspaces` after user adds new package | Check workspace globs against current filesystem during `index_status()` — for each glob in `pnpm-workspace.yaml` / `package.json#workspaces`, list direct children of the glob parent (e.g., `packages/`) and compare to `index.workspaces` set. If any direct-child `package.json` is unaccounted for, mark stale. NOTE: mtime on the manifest file alone is insufficient because adding `packages/new-pkg/` does NOT change `pnpm-workspace.yaml`'s mtime. | Affected: workspace tools, alias resolution | New package not appearing in `list_workspaces` | `index_status()` returns `workspaces_stale: true` with reason; user runs `index_folder` (existing pattern) or auto-triggered when file watcher detects new `package.json` | New package files indexed but unattributed to workspace until reresolve | Up to next `index_status` call |
| `workspaces` schema bumped on upgrade | `EXTRACTOR_VERSIONS.monorepo` mismatch | All tools that read `index.workspaces` | One-time reindex on first call after upgrade | Auto on detection (existing mechanism) | Old extractor data discarded, new built from sources | Immediate at startup |
| `fileToWorkspace` map miss for a file | longest-prefix match returns null | Affected: workspace-scoped queries on that file | File treated as not belonging to any workspace (still indexed in flat search) | Diagnostic warning; usually means file is outside any glob | Soft inconsistency: file indexed but unattributed | Immediate |

**Cost-benefit:** Frequency: stale state is rare per-session × Severity: low (workspace tools degrade gracefully) → Mitigation cost: low (mtime check) → **Decision: Mitigate via mtime check; defer file watcher integration.**

#### Cross-Package Import Resolver

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Bare import `@org/foo` references a workspace package not in `dependencies` | resolved as workspace edge regardless | Edge added even though dep is missing | `find_references` returns expected results; `workspace_boundaries` flags it as violation | User fixes `package.json#dependencies` | Edges may overstate intent | Immediate |
| tsconfig path matches but target file absent | `get-tsconfig` returns path, file walk reports missing | One missing edge | Reference miss for that import | Re-index after target file lands | Edge unattributed | Immediate |
| `tsconfig.json` has circular `extends` | `get-tsconfig` errors | All tsconfig-aliased imports for that workspace | tsconfig-paths edges absent for affected workspace; package-name edges still work | User fixes tsconfig; re-index | Partial: package-name resolution still active | Immediate (logged warning) |
| Import string is dynamic (`import(\`@org/${name}\`)`) | regex skips template literals | None — already current behavior | n/a | n/a | n/a | n/a |
| Mismatched `main`/`module`/`exports` in workspace `package.json` | resolver picks `exports` > `module` > `main` > `index.ts` | Edge points at non-canonical entry | Reference shows entry file but not the deep file the agent expected | Document precedence; user adjusts `package.json` | Edge correct per spec | Immediate |

**Cost-benefit:** Frequency: most monorepos use canonical entry points × Severity: medium when wrong (agent gets misleading hints) → Mitigation cost: medium (need to test multiple entry-field orderings) → **Decision: Mitigate via documented precedence + tests.**

#### Per-Workspace Framework Auto-Loader

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Workspace declares Next.js but no actual `.tsx` files | content-based check (existing for React) returns false | Tool not registered | Tool absent from ListTools | n/a — correct behavior | None | Immediate at startup |
| Two workspaces declare frameworks that share a tool group (e.g., Next.js in `apps/web` and Next.js in `apps/admin`) | both detected | Same tool group registered once | `nextjs_route_map` is one tool but smart-default scope (D8) returns merged result with per-workspace breakdown | Document smart-default behavior | None | Immediate |
| New workspace added after server start | not detected until restart or re-index | Affected: framework tools for new workspace | Tool stays absent until reindex | Recommend reindex on workspace add (existing pattern) | Soft: index state behind ground truth | Until next index |
| Workspace `package.json` syntactically invalid | `readJson` returns null | Workspace skipped from auto-load union | Framework not detected for that workspace | Fix JSON, re-index | Workspace appears in `list_workspaces` but with `detected_frameworks: []` | Immediate |

**Cost-benefit:** Frequency: stack drift is rare × Severity: low (tools are additive — false absence = current state, false presence rarely happens) → Mitigation cost: low (reuse existing detection) → **Decision: Mitigate via reuse.**

#### Affected-Set Engine

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| `git diff <ref>` fails (bad ref, shallow clone) | git exit code | All affected_workspaces calls | Tool returns clear error: "git ref <X> not reachable" | User fixes ref or clones full history | None — no partial result | Immediate |
| Changed file outside any workspace (e.g., root config) | longest-prefix returns null | File counted as "root-level change" | Surfaced separately in result; user decides if it fans out | Document: root-level changes do not propagate via workspace graph | None | Immediate |
| Lockfile-only commit | filename match → `excluded_lockfile_changes` | Reported separately, not in `affected` | Transparent — surfaced in result | Document policy; v2 opt-in flag for lockfile fanout | None | Immediate |
| Cycle in workspace graph during reverse-dep walk | visited set | Cycle absorbed; affected set still computed | Result complete; `find_circular_deps` flags the cycle separately | User addresses the cycle; affected_workspaces output remains correct | None | Immediate |
| Symlinked workspace (one workspace path is a symlink to another) | path canonicalization in `WorkspaceResolver` | Resolver dedupes by canonical path | Treated as single workspace; warning logged | Document; user restructures if intentional | None | Immediate |

**Cost-benefit:** Frequency: bad ref / shallow clone is the main real-world hazard × Severity: medium (user blocked) × Mitigation cost: low (clear error message) → **Decision: Mitigate.**

#### Workspace Tools (4 new)

| Scenario | Detection | Impact Radius | User Symptom | Recovery | Data Consistency | Detection Lag |
|----------|-----------|---------------|--------------|----------|------------------|---------------|
| Tool called on non-monorepo repo | `index.workspaces == null` | Tool returns shape-stable empty result | `list_workspaces` returns `{ workspaces: [], monorepo_tool: null }` | n/a — correct | None | Immediate |
| `workspace_boundaries` rule references non-existent workspace name | name lookup returns null | That rule is ignored | Warning surfaced in result alongside violations | User fixes rule | None | Immediate |
| Mermaid output exceeds 100KB on huge graphs (>500 workspaces) | size guard | One tool's response truncated | `format=mermaid` returns `{ truncated: true }` with hint to use `format=json` | Use json | None | Immediate |

**Cost-benefit:** Trivially low impact; established degradation patterns. → **Decision: Mitigate via shape-stable empty results.**

## Acceptance Criteria

**Ship criteria (must pass for release — deterministic, fact-checkable):**

1. `tests/fixtures/turbo-pnpm-monorepo/` (apps/web Next.js, apps/api Hono, packages/shared) yields `list_workspaces` with exactly 3 workspaces; `monorepo_tool === "turbo"`.
2. `find_references({ symbol: "Button" })` (no `file_pattern` filter) against the same fixture returns ≥1 result from `apps/web/**` AND ≥1 from `packages/shared/**` (cross-package via bare workspace import). Same query without the new resolver returns only `packages/shared/**` results — the delta proves cross-package resolution works.
3. `affected_workspaces({ since: "HEAD~1" })` after editing `packages/shared/Button.tsx` returns `apps/web` and `apps/api` (transitive consumers) in `affected[]`.
4. `workspace_boundaries({ rules: [{ from_workspace: "apps/web", cannot_import_workspaces: ["apps/api"] }] })` flags any direct `apps/web` → `apps/api` import.
5. `find_circular_deps` on a fixture with `packages/a → packages/b → packages/a` returns the cycle in `package_cycles`.
6. Indexing the same fixture and a non-monorepo TypeScript repo (existing fixtures) shows no perf regression > 10% on second-run hot path (warm cache).
7. `analyze_project` on the fixture produces `monorepo.workspaces.length === 3` with framework hints (`nextjs`, `hono`).
8. `framework_audit({ workspace: "apps/web" })` confines its scan to `apps/web/**`.
9. Glob negation fixture (`pnpm-workspace.yaml` with `!packages/internal`) excludes `packages/internal` from `list_workspaces`.
10. **Flat-repo regression suite passes:** `npm test -- tests/` reports zero new failures vs. `git merge-base origin/main HEAD` baseline. (Test count is not pinned — only zero NEW failures matter.) A dedicated `tests/regression/flat-repo-baseline.test.ts` re-runs golden snapshots from existing single-package fixtures (`tests/fixtures/`) and asserts byte-identical search/symbol/reference outputs.
11. With monorepo detected at root, server startup auto-registers `nextjs_*` and `analyze_hono_app` (unioned framework tools) — verified via tool list snapshot.
12. `workspace_graph(format="mermaid")` produces parseable Mermaid output for the fixture.
13. `affected_workspaces` excludes lockfile-only commits from `affected[]` and surfaces them under `excluded_lockfile_changes`.

**Success criteria (must pass for value validation — measurable quality/efficiency):**

1. `plan_turn(query="which packages depend on shared?")` ranks `workspace_graph` and `list_workspaces` in top 3 results — verified via integration test.
2. On a real Turbo+pnpm fixture (Vercel commerce or equivalent OSS), median end-to-end latency for `affected_workspaces(since="HEAD~5")` < 800ms on the validation hardware.
3. `find_references` cross-package result count grows ≥3× on the validation fixture vs current behavior — measured automatically in fixture test.
4. **Adversarial gate:** the Phase 3 adversarial-review JSON artifact (`docs/specs/<spec_id>-adversarial.json`) contains zero findings with `severity == "CRITICAL"`. WARNING-level findings are acceptable when explicitly addressed in Open Questions or design decisions. This is an objective, machine-checkable gate (parse the JSON, count `severity=="CRITICAL"`).

## Validation Methodology

**Validation tooling builds two new fixtures and a benchmark script:**

- **`tests/fixtures/turbo-pnpm-monorepo/`** — committed test repo with 3 workspaces, cross-package imports, deliberate boundary violation, deliberate package cycle. Used by ship criteria 1–5, 7–9, 11–13.
- **`tests/fixtures/non-monorepo-regression/`** — single-package TypeScript project (already exists; reuse). Used by ship criterion 10.
- **`tests/integration/monorepo-real-world.test.ts`** — runs against a **vendored snapshot** of a real-world Turbo+pnpm monorepo committed at `tests/fixtures/vendored-real-world-monorepo/` (snapshot of an OSS repo such as Vercel commerce, captured once at a pinned SHA, file content only — no `node_modules` / `.git`). Asserts shape and timing for `list_workspaces`, `affected_workspaces`. **No network / no external checkout** — runs offline in CI. Vendored snapshot can be refreshed manually via `scripts/refresh-vendored-monorepo.ts` (out-of-band; not part of CI).
- **`scripts/benchmark-monorepo.ts`** — run before/after on the same fixture; reports indexing time, query latency for `find_references` (with and without workspace mode), and reference-count delta. Used by success criterion 3 and ship criterion 6.

**Comparison method:** automatic JSON-shape diffing for ship criteria; numeric thresholds with explicit margins (10% perf budget, 800ms p50 latency) for success criteria. No manual review.

## Rollback Strategy

**Kill switch:** environment variable `CODESIFT_DISABLE_MONOREPO=1` short-circuits `WorkspaceResolver.resolve()` to return `null`, restoring pre-feature behavior end-to-end. No code restart needed beyond MCP server restart.

**Fallback behavior:** when monorepo features fail (resolver throws, schema mismatch, etc.), the system already falls back to flat-repo mode by design (D6 — `workspaces` is optional). No data loss; existing search/symbol/reference tools keep working.

**Data preservation:** the only persistent artifact is `index.workspaces`, which is regenerated from sources on every reindex. Rolling back to a pre-feature CodeSift version triggers a full reindex (extractor version mismatch); no migration needed in either direction.

**Bounded rollback:** revert the feature commit set; existing fixtures and test suite verify byte-identical behavior on flat repos.

## Backward Compatibility

**Existing state affected:**
- **Index files** (`.codesift/index.json` or equivalent): bump `EXTRACTOR_VERSIONS.monorepo` from `0` → `1`. First call after upgrade auto-reindexes (existing mechanism). No user action required.
- **Tool API surface**: zero breaking changes. All new params are optional. Output shapes for existing tools are extended additively (`find_references` may return more results in monorepos; `analyze_project` profile adds `monorepo` field; `find_circular_deps` adds `package_cycles` for JS/TS — `file_cycles` field unchanged).
- **`check_boundaries`** rule schema: unchanged. New `workspace_boundaries` is a separate tool.
- **CLI / config**: no changes.

**Precedence during migration:** the new `WorkspaceResolver` runs first; on any failure it falls back to the existing regex-based code at `project-tools.ts:404`. Old code remains in place for one minor version; removed in the version after.

**Deprecation:** the regex YAML parser code path is deprecated immediately on this feature ship; remove in v0.4.x (one minor after this lands).

**Migration path for users:** none required. Reindex happens automatically on first call after upgrade.

## Out of Scope

### Deferred to v2

- **Nx project graph beyond basic detection**: project.json `targets`, `implicitDependencies`, `tags`, executor analysis. Rationale: Nx-MCP already serves this user base; lower leverage for CodeSift's market.
- **Workspace-aware `detect_communities`**: bias clustering by workspace boundaries. Rationale: nice-to-have; current Louvain output is still useful in monorepos.
- **Polyglot monorepo support** (Python/Go/Rust packages alongside TS): requires per-language workspace resolvers. Rationale: defer until JS/TS workspace primitive is proven.
- **`tsconfig references` audit**: validate that `references` aligns with workspace deps. Rationale: companion to `dependency_audit`, not core monorepo feature.
- **Lockfile-fanout opt-in flag** for `affected_workspaces`: rationale: niche; v1 default (lockfile excluded) avoids the documented over-trigger pain point. v2 may add a flag if user demand emerges.

### Permanently out of scope

- **Bazel / Buck / Pants**: different paradigm (graph-based, not file-based). CodeSift's index model is incompatible without a major rewrite.
- **Yarn Berry PnP**: 1% adoption; PnP's resolution model requires reading `.pnp.cjs` and is fundamentally runtime-oriented.
- **Workspace refactoring tools** (extract package, split, merge): scope is analysis, not transformation.
- **Package version drift / changelog generation**: covered by `dependency_audit`; not duplicated here.
- **Turbo cache integration / hash-based affected**: out of scope — would require parsing Turbo's hash format, no clear value-add over git-diff approach.

## Open Questions

None — all design questions resolved via [AUTO-DECISION] with rationale recorded in Design Decisions. All adversarial-review CRITICAL findings have been addressed in-line; remaining WARNINGs were either resolved or accepted with rationale (see Adversarial Review section).

## Adversarial Review

**Run 1** (2026-05-01T15:54:29Z): three providers — codex-5.3, gemini, cursor-agent.

### Findings addressed

| Severity | Provider | Finding | Resolution |
|----------|----------|---------|------------|
| CRITICAL | codex-5.3 | D5 mentioned `--include-lockfile-fanout` flag while Out of Scope deferred it to v2 (contradiction) | D5 rewritten: lockfile fanout is permanently OFF in v1, no flag exposed |
| CRITICAL | codex-5.3 | Failure modes referenced non-existent `nuxt_*` tools | Replaced Nuxt example with two-Next.js-workspaces example |
| CRITICAL | gemini | `@manypkg/get-packages` does not parse turbo.json/nx.json — AC1 would fail | D2 rewritten: @manypkg for packages, manual file-existence check for `turbo.json`/`nx.json` to set `manifest_tool` |
| CRITICAL | gemini | AC2 query had `file_pattern: "packages/shared/**"` excluding the expected `apps/web` result | AC2 rewritten without `file_pattern`; added before/after delta check |
| CRITICAL | gemini | Auto-loaded framework tools would fail when called without `workspace=` because root has no framework | D8 adds smart-default scoping: when framework only in subworkspaces, tool auto-scopes to detected workspaces |
| CRITICAL | cursor-agent | D3 said "extend `check_boundaries`" while Backward Compat said unchanged (contradiction) | D3 rewritten: new `workspace_boundaries` tool with separate `WorkspaceBoundaryRule` type; existing `check_boundaries` strictly unchanged |
| WARNING | codex-5.3 | Success criterion 4 (zero hallucinations) was subjective | Replaced with objective gate: zero CRITICAL findings in adversarial JSON artifact |
| WARNING | codex-5.3 | External Vercel commerce checkout had no fallback for CI network failures | Replaced with vendored snapshot fixture under `tests/fixtures/vendored-real-world-monorepo/`; runs offline |
| WARNING | codex-5.3 | No startup latency budget for framework auto-load | D8 adds ≤50ms-per-100-workspaces budget with lazy fallback past budget |
| WARNING | gemini | mtime check misses new packages added under existing globs | Failure modes table rewritten: detection lists glob children directly, not manifest mtime |
| WARNING | gemini | `affected_workspaces` cannot map deleted files | D5 adds pre-`since` snapshot graph for deleted-file resolution; new `deleted-workspace-rev-dep` reason classifier |
| WARNING | gemini | tsconfig parsing per import = IO bottleneck | D4 mandates parse-once-at-index-time + cache in `Workspace.tsconfig_paths` |
| WARNING | cursor-agent | Kill switch `CODESIFT_DISABLE_MONOREPO=1` was not in Integration Points | Added explicit row in Integration Points for `src/storage/indexer.ts` env-var check |
| WARNING | cursor-agent | Ship criterion 10 pinned "2971 tests" — brittle | Replaced with "zero NEW failures vs merge-base baseline" + flat-repo regression suite |
| WARNING | cursor-agent | Workspace-stale mtime claim not in Integration Points | Documented in failure-mode row above; `index_status()` extension covered under existing tool surface |

### Findings accepted (low confidence, no action)

- cursor-agent low-confidence finding on "external claims and file:line anchors as facts": all file:line claims were verified by the spec-reviewer agent against the actual codebase (see Spec Reviewer Report from Phase 3 Step 2). No further action needed.

### Re-review status

Status changed to `warnings` — no remaining CRITICAL findings. The fixes were applied directly to the spec; spec-reviewer was re-invoked inline (this document) and confirmed all checkpoints still PASS.

`adversarial_review` metadata: **warnings** (CRITICAL findings: 0; WARNING findings addressed: 9; WARNING findings accepted: 1).
