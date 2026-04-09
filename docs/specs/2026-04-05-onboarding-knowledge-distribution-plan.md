# Implementation Plan: Onboarding & Knowledge Distribution

**Spec:** docs/specs/2026-04-05-onboarding-knowledge-distribution-spec.md
**spec_id:** 2026-04-05-onboarding-knowledge-2030
**plan_revision:** 1
**status:** Approved
**Created:** 2026-04-05
**Tasks:** 8
**Estimated complexity:** 6 standard, 2 complex

## Architecture Summary

Two distribution channels: MCP `instructions` (universal, ~800 tok per session) + platform-specific rules files (durable, zero per-session cost). `codesift setup <platform>` installs everything by default: config + rules + hooks. Rules bundled in npm package `rules/` dir.

Key files: `src/server.ts` (instructions), `src/cli/setup.ts` (rules install), `src/cli/commands.ts` (flag fix), `rules/` (new dir), `src/tools/generate-tools.ts` (enhance output).

## Technical Decisions

- MCP SDK `instructions` field confirmed in v1.27.1 — add as second arg to McpServer constructor
- Package root resolution: `fileURLToPath(import.meta.url)` + two-level dirname search (existing pattern from `getVersion()`)
- Rules idempotency: SHA-256 hash of template content, version header line excluded from hash input
- Hooks default: `?? true` (fix from `?? false`)
- Content dedup (CQ14): `instructions.ts` is single source of truth. `generate_claude_md` imports from it. `rules/codesift.md` is the full version, instructions is the compact version.

## Quality Strategy

- **Test framework:** Vitest, globals, singleFork. Mock `node:os` homedir with tmpdir (established pattern in setup.test.ts)
- **CQ gates:** CQ3 (path validation for codex/gemini projectDir), CQ8 (error isolation in installRules — try/catch, best-effort), CQ14 (import CODESIFT_INSTRUCTIONS in generate_claude_md, don't duplicate)
- **Risk areas:** handleSetup has ZERO tests → add before modifying. `?? false` → `?? true` is behavior-changing default. Rules file I/O needs error isolation.
- **No snapshot tests exist** — generate_claude_md uses toContain assertions, safe to extend

## Task Breakdown

---

### Task 1: Create instructions.ts — compact guidance string
**Files:** `src/instructions.ts` (NEW), `tests/instructions.test.ts` (NEW)
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Create `tests/instructions.test.ts`
  - Test `CODESIFT_INSTRUCTIONS` is exported, non-empty string
  - Test length < 4000 chars (~1000 tokens max)
  - Test contains "discover_tools" (tool discovery flow)
  - Test contains "H1" and "H9" (hint code legend)
  - Test contains "ALWAYS" and "NEVER" (rules)
  - Test contains "ranked" (key param)
  - Test contains "describe_tools" (discovery flow)
- [ ] GREEN: Create `src/instructions.ts` exporting `CODESIFT_INSTRUCTIONS` const string
  - Compact ~800 token guidance covering: tool count (66 tools, 14 visible), discovery flow, H1-H9 legend, ALWAYS/NEVER rules, key params, cascade behavior
  - Content derived from CLAUDE.md but condensed using abbreviations
- [ ] Verify: `npx vitest run tests/instructions.test.ts`
  Expected: 7 tests passed
- [ ] Acceptance: Spec AC #1 content source
- [ ] Commit: `feat: add CODESIFT_INSTRUCTIONS compact guidance for MCP instructions field`

---

### Task 2: Wire instructions into server.ts
**Files:** `src/server.ts`
**Complexity:** standard
**Dependencies:** Task 1
**Execution routing:** default

- [ ] RED: Create `tests/server.test.ts` (or extend if exists)
  - Test that server.ts imports CODESIFT_INSTRUCTIONS
  - Since server.ts starts stdio transport (side-effect), test at module level: import `CODESIFT_INSTRUCTIONS` from instructions.ts, verify it's the string used in server
  - Alternatively: read server.ts source and assert it contains `instructions: CODESIFT_INSTRUCTIONS`
- [ ] GREEN: Modify `src/server.ts`:
  - Add `import { CODESIFT_INSTRUCTIONS } from "./instructions.js";`
  - Change McpServer call: `new McpServer({ name: "codesift-mcp", version: "0.1.0" }, { instructions: CODESIFT_INSTRUCTIONS })`
- [ ] Verify: `npx tsc --noEmit` (type check — server.ts is hard to unit test due to stdio)
  Expected: clean compile (only pre-existing errors)
- [ ] Acceptance: Spec AC #1
- [ ] Commit: `feat: send CODESIFT_INSTRUCTIONS via MCP instructions field to all clients`

---

### Task 3: Create rules/ directory with platform templates
**Files:** `rules/codesift.md` (NEW), `rules/codesift.mdc` (NEW), `package.json`
**Complexity:** standard
**Dependencies:** Task 1 (imports CODESIFT_INSTRUCTIONS for content reference)
**Execution routing:** default

- [ ] RED: Create `tests/rules-content.test.ts`
  - Test `rules/codesift.md` exists and is readable
  - Test starts with `<!-- codesift-rules v` header
  - Test contains all sections: "Tool Mapping", "ALWAYS", "NEVER", "Hint Codes", "Key Parameters"
  - Test `rules/codesift.mdc` exists for Cursor
  - Test content is >500 chars and <10000 chars (sanity bounds)
- [ ] GREEN:
  - Create `rules/codesift.md` — full rules file with: header line (`<!-- codesift-rules vX.Y.Z hash:H -->`), tool discovery flow, complete tool mapping table, all situational triggers, ALWAYS/NEVER rules, hint codes H1-H9, key parameters, hooks setup guidance
  - Create `rules/codesift.mdc` — Cursor MDC format variant (same content, MDC frontmatter)
  - Add `"rules"` to `package.json` `files` array
- [ ] Verify: `npx vitest run tests/rules-content.test.ts`
  Expected: 5 tests passed
- [ ] Acceptance: Spec AC #11
- [ ] Commit: `feat: add rules/ directory with platform-specific guidance templates`

---

### Task 4: Fix commands.ts — hooks default + flag parsing
**Files:** `src/cli/commands.ts`, `tests/cli/commands.test.ts`
**Complexity:** standard
**Dependencies:** none
**Execution routing:** default

- [ ] RED: Add tests to `tests/cli/commands.test.ts`
  - Test `handleSetup(["claude"], {})` — calls `setup("claude", { hooks: true, rules: true })` by default
  - Test `handleSetup(["claude"], { hooks: "false" })` — calls `setup("claude", { hooks: false, ... })`
  - Test `handleSetup(["claude"], { "no-rules": true })` — calls `setup("claude", { rules: false, ... })`
  - Test `handleSetup([], {})` — calls die() with usage message
  - Mock `setup` import, spy on `process.stdout.write` and `process.exit`
- [ ] GREEN: Modify `src/cli/commands.ts`:
  - Change `getBoolFlag(flags, "hooks") ?? false` to `getBoolFlag(flags, "hooks") ?? true`
  - Add `const rules = getBoolFlag(flags, "rules") ?? true;`
  - Add `const force = getBoolFlag(flags, "force") ?? false;`
  - Pass `{ hooks, rules, force }` to `setup(platform, { hooks, rules, force })`
- [ ] Verify: `npx vitest run tests/cli/commands.test.ts`
  Expected: all tests passed
- [ ] Acceptance: Spec AC #7, AC #8, AC #12
- [ ] Commit: `fix: default hooks and rules to true in setup command, parse --force flag`

---

### Task 5: installRules function in setup.ts
**Files:** `src/cli/setup.ts`, `tests/cli/setup.test.ts`
**Complexity:** complex
**Dependencies:** Task 3 (rules/ dir exists), Task 4 (flags parsed)
**Execution routing:** deep

- [ ] RED: Extend `tests/cli/setup.test.ts`
  - Test `setup("claude", { rules: true })` creates `.claude/rules/codesift.md` in tmpHome
  - Test re-run with same version + unmodified → skips (no write)
  - Test re-run with modified file (change content after first write) → skips + returns "skipped" (user modified)
  - Test `setup("claude", { rules: true, force: true })` on modified file → overwrites
  - Test `setup("claude", { rules: false })` → no rules file written
  - Test `.claude/rules/` directory created if absent
  - Test error on source file missing → graceful fallback, no throw
- [ ] GREEN: Add to `src/cli/setup.ts`:
  - `SetupOptions` type: add `rules?: boolean` (default true), `force?: boolean` (default false)
  - `resolvePackageFile(relativePath)` — two-level dirname search (match `getVersion()` pattern)
  - `installRules(platform, homeDir, options)`:
    1. Resolve source: `resolvePackageFile("rules/codesift.md")`
    2. Compute template hash: SHA-256 of source content (exclude header line)
    3. Determine target path per platform
    4. If target exists: parse header version+hash, compare, skip/update/warn
    5. If target absent: create dir, write file with header
    6. Return `{ path, action }`
  - Call `installRules` from `setupClaude`/`setupCursor` when `options.rules !== false`
  - Wrap in try/catch → return `{ path, action: "error", error: message }` on failure (CQ8)
- [ ] Verify: `npx vitest run tests/cli/setup.test.ts`
  Expected: all tests passed
- [ ] Acceptance: Spec AC #2, AC #4, AC #9, AC #10
- [ ] Commit: `feat: install platform-specific rules files during setup with version tracking`

---

### Task 6: Codex + Gemini append-mode rules
**Files:** `src/cli/setup.ts`, `tests/cli/setup.test.ts`
**Complexity:** standard
**Dependencies:** Task 5
**Execution routing:** default

- [ ] RED: Extend `tests/cli/setup.test.ts`
  - Test `setup("codex", { rules: true })` appends delimited block to `AGENTS.md` in cwd
  - Test re-run codex: existing delimited block replaced in-place, not duplicated
  - Test `setup("gemini", { rules: true })` appends delimited block to `GEMINI.md`
  - Test re-run gemini: block replaced, not duplicated
  - Test AGENTS.md with existing user content before and after the block → preserved
- [ ] GREEN: In `installRules`, add platform-specific logic:
  - For codex/gemini: read target file, find `<!-- codesift-rules-start -->` / `<!-- codesift-rules-end -->` delimiters
  - If found: replace block content between delimiters
  - If not found: append `\n<!-- codesift-rules-start -->\n{content}\n<!-- codesift-rules-end -->\n`
  - Target: `AGENTS.md` (codex), `GEMINI.md` (gemini) in current working directory
- [ ] Verify: `npx vitest run tests/cli/setup.test.ts`
  Expected: all tests passed
- [ ] Acceptance: Spec AC #5, AC #6
- [ ] Commit: `feat: append-mode rules for Codex AGENTS.md and Gemini GEMINI.md`

---

### Task 7: Enhance generate_claude_md with behavioral guidance
**Files:** `src/tools/generate-tools.ts`, `tests/integration/tools.test.ts`
**Complexity:** standard
**Dependencies:** Task 1 (imports CODESIFT_INSTRUCTIONS)
**Execution routing:** default

- [ ] RED: Extend `tests/integration/tools.test.ts` generate_claude_md section
  - Test output contains "CodeSift Usage" or "Hint Codes" section
  - Test output contains "H1" hint code reference
  - Test output contains "discover_tools" mention
  - Test output still contains "Architecture Overview" (regression)
  - Test guidance section appears AFTER architecture section
- [ ] GREEN: In `src/tools/generate-tools.ts`:
  - Import `CODESIFT_INSTRUCTIONS` from `../instructions.js` (CQ14: single source)
  - After the architecture overview lines, append a `## CodeSift Usage Hints` section
  - Content: render CODESIFT_INSTRUCTIONS formatted as markdown sections
  - Keep under 200 lines total in generate-tools.ts
- [ ] Verify: `npx vitest run tests/integration/tools.test.ts -t "generateClaudeMd"`
  Expected: all generate_claude_md tests passed
- [ ] Acceptance: Spec AC #13
- [ ] Commit: `feat: include behavioral guidance in generate_claude_md output`

---

### Task 8: Setup CLI output + help text
**Files:** `src/cli/setup.ts`, `src/cli/help.ts`, `tests/cli/setup.test.ts`
**Complexity:** standard
**Dependencies:** Task 5, Task 6
**Execution routing:** default

- [ ] RED: Extend `tests/cli/setup.test.ts`
  - Test `formatSetupResult` includes rules file path when rules installed
  - Test setup output for "all" platform lists all written files
  - Test help text includes `--no-rules`, `--no-hooks`, `--force` flags
- [ ] GREEN:
  - Extend `formatSetupResult` to include rules path and hooks status
  - Update `src/cli/help.ts` with new flags documentation
  - Setup output: one `✓ [action] path` line per file written
- [ ] Verify: `npx vitest run tests/cli/setup.test.ts`
  Expected: all tests passed
- [ ] Acceptance: Spec AC #14 (should-have)
- [ ] Commit: `feat: verbose setup output showing all installed files and flags`

---

## Final Verification

After all 8 tasks:
```bash
npx vitest run                    # 0 regressions
npx tsc --noEmit                  # clean compile (pre-existing errors only)
```

## Dependency Graph

```
T1 (instructions.ts) ──→ T2 (server.ts)
         │
         ├──→ T3 (rules/) ──→ T5 (installRules) ──→ T6 (codex/gemini append)
         │                                      └──→ T8 (CLI output)
         └──→ T7 (generate_claude_md)

T4 (commands.ts fix) ──→ T5 (installRules)
```

T1, T4 have no deps — can start in parallel.
T2, T3, T7 depend only on T1.
T5 depends on T3 + T4.
T6, T8 depend on T5.
