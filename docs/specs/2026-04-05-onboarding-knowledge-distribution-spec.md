# Onboarding & Knowledge Distribution — Design Specification

> **spec_id:** 2026-04-05-onboarding-knowledge-2030
> **topic:** Distribute agent guidance to every user on every platform automatically
> **status:** Approved
> **created_at:** 2026-04-05T20:30:00Z
> **approved_at:** 2026-04-05T20:45:00Z
> **approval_mode:** interactive
> **author:** zuvo:brainstorm

## Problem Statement

After `npm install codesift-mcp && codesift setup claude`, users get a running MCP server but ZERO guidance on how to use it. All agent knowledge (tool discovery flow, hint codes, ALWAYS/NEVER rules, situational triggers, key parameters, hooks) exists only in the project owner's private files. New users see 14 tools with one-line descriptions. They don't know 50+ tools are hidden. They don't know what H1-H9 codes mean. They waste tokens on redundant calls. Competitors (jcodemunch, Serena, lean-ctx) solve this with automatic onboarding.

**Who is affected:** Every CodeSift user except the project owner.
**What happens if we do nothing:** Users get 20% of CodeSift's value. Token waste. Churn. Competitors win.

## Design Decisions

### D1: Two distribution channels — MCP instructions (universal) + setup rules (durable)
**Chosen:** MCP `instructions` field delivers ~800 tokens of compact guidance to EVERY MCP client automatically (zero setup). `codesift setup` writes platform-specific rules files for durable, zero-cost-per-session guidance.
**Why:** MCP instructions = universal (Claude Code, Cursor, Codex, Gemini, Zed, Aider, Continue). Rules files = zero token cost after first write. Both channels together give best coverage.
**Rejected:** Only MCP instructions (800 tok/session cost without durable rules). Only rules files (requires user to run setup).

### D2: Setup installs everything by default
**Chosen:** `codesift setup claude` = config + rules + hooks. Opt-out via `--no-rules` / `--no-hooks`.
**Why:** jcodemunch `init` does this and grows +21 stars/day. Users don't read docs. One command = full experience.
**Rejected:** Explicit flags `--rules` / `--hooks` (bad onboarding, users skip what they don't know about).

### D3: Rules content bundled in npm package
**Chosen:** Ship a `rules/` directory in the npm package containing platform-specific rule templates. `setup` copies from there.
**Why:** Works offline. Updates with `npm update`. No network dependency.
**Rejected:** Downloading rules from a URL (fragile, requires internet).

### D4: Idempotent setup with version tracking
**Chosen:** Rules files include a `codesift-version: X.Y.Z` header. Re-running `setup` compares versions: if package is newer, updates rules. If user modified the file (detected by hash), warns and offers `--force`.
**Why:** Solves the "npm update but rules are stale" problem without overwriting user customizations.

### D5: Platform-specific rules format
**Chosen:** Each platform gets its native format:
- Claude Code: `.claude/rules/codesift.md` (markdown, auto-loaded by Claude Code from project rules dir)
- Cursor: `.cursor/rules/codesift.mdc` (Cursor's MDC format)
- Codex: `AGENTS.md` append (Codex convention)
- Gemini: `GEMINI.md` append (Gemini CLI convention)
**Why:** Each platform has different conventions. Native format = auto-loaded without user configuration.

### D6: MCP instructions content — compact, ~800 tokens
**Chosen:** Compress all essential guidance into ~800 tokens using abbreviated format (inspired by lean-ctx TDD approach). Content: tool discovery flow, H1-H9 legend, top 10 ALWAYS/NEVER rules, key params table.
**Why:** MCP instructions are sent on every session. 800 tokens is the lean-ctx-proven sweet spot: enough for effective guidance, low enough to not bloat context.

## Solution Overview

```
npm install codesift-mcp
        │
        ▼
    MCP Server starts
        │
        ├── instructions: "~800 tok compact guide" ──→ EVERY client sees this
        │                                              (Claude, Cursor, Codex, Gemini, Zed...)
        │
        ▼
codesift setup claude          (or cursor/codex/gemini)
        │
        ├── Config ──→ MCP server entry (existing)
        ├── Rules  ──→ .claude/rules/codesift.md (NEW — full tool mapping, params, triggers)
        └── Hooks  ──→ .claude/settings.local.json (PreToolUse + PostToolUse)
```

## Detailed Design

### MCP Instructions Content

File: `src/instructions.ts` (new, ~60 lines)

Exports a `CODESIFT_INSTRUCTIONS` string constant (~800 tokens). Content structure:

```
CodeSift — 63 tools (13 visible, 50 hidden).

DISCOVERY: discover_tools(query) → describe_tools(names) → call tool directly.

HINT CODES (appear in responses):
H1(n)=add group_by_file  H2(n,t)=batch into t  H3(n)=cache list_repos
H4=add file_pattern  H5=use cached tree  H6(n)=add detail_level=compact
H7=use get_context_bundle  H8(n)=use assemble_context(L1)  H9=use semantic search

ALWAYS: search_text(ranked=true) for symbol context | semantic_search for concepts |
  trace_route for endpoints | index_file after edit (9ms) | detail_level=compact |
  file_pattern with include_source | get_symbols batch for 2+ | codebase_retrieval for 3+ searches

NEVER: list_repos >1x | search_patterns then search_text (redundant) |
  Read entire file for 1 symbol (use get_symbol) | index_folder if repo indexed

KEY PARAMS: search_text: ranked=true, group_by_file=true, auto_group=true |
  search_symbols: detail_level=compact/standard/full, token_budget=N |
  assemble_context: level=L0(source)/L1(sigs)/L2(files)/L3(dirs) |
  codebase_retrieval: token_budget=N, type=semantic for concepts

RESPONSE CASCADE: >52K chars=[compact], >87K=[counts], >105K=truncated.
  Skipped when detail_level or token_budget set explicitly.
```

### Rules File Content

File: `rules/claude.md` (new, shipped in npm package, ~150 lines)

Full version of codesift.md with:
- Complete tool mapping table (34 mappings)
- All situational triggers (34 triggers)
- All ALWAYS rules (10)
- All NEVER rules (5)
- Full key parameters section
- Hint code legend with actions
- Hook description

Platform variants:
- `rules/claude.md` → copied to `.claude/rules/codesift.md`
- `rules/cursor.mdc` → copied to `.cursor/rules/codesift.mdc`
- `rules/codex.md` → appended to `AGENTS.md`
- `rules/gemini.md` → appended to `GEMINI.md`

Each file starts with:
```markdown
<!-- codesift-rules v0.1.0 hash:abc123 -->
```
**Hash algorithm:** SHA-256 of the template content (the rules file BEFORE the header line is prepended). The header line itself is excluded from the hash input. Compare: compute SHA-256 of target file content minus the first line → if matches template hash → unmodified.

Used for version detection and modification tracking on re-run.

### Setup Command Changes

File: `src/cli/setup.ts`

**`setup(platform, options?)` signature change:**
```typescript
interface SetupOptions {
  hooks?: boolean;    // default: true (was: false)
  rules?: boolean;    // NEW, default: true
  force?: boolean;    // NEW, default: false — overwrite modified rules
}
```

**New function: `installRules(platform, projectDir, options)`**
1. Determine source: `path.join(__dirname, '../../rules', platformFile)`
2. Determine target: platform-specific path (see D5)
3. If target exists:
   - Parse `codesift-rules vX.Y.Z hash:H` header
   - If version matches current package version → skip (already up to date)
   - If hash matches template hash → safe to overwrite (user didn't modify)
   - If hash differs → user modified → warn, skip unless `--force`
4. Write file (copy for Claude/Cursor, append for Codex/Gemini)
5. Return `{ path, action: "created" | "updated" | "skipped" | "force-updated" }`

**CLI output contract:** `commands.ts` prints one line per file: `✓ [action] path` (e.g., `✓ [created] .claude/rules/codesift.md`). On partial failure (e.g., hooks fail but rules succeed), print the error inline and exit 0 (setup is best-effort, not atomic). On total failure, exit 1.

**New function: `installHooks(platform, projectDir)`** (extract from existing `setupClaudeHooks`)

**Bug fix:** `commands.ts:460` — parse `--no-rules`, `--no-hooks`, `--force` flags and pass to `setup()`.

### Package.json Changes

Add `"rules"` to `files` array:
```json
"files": ["dist", "src/parser/languages", "rules", "README.md", "LICENSE"]
```

### server.ts Changes

```typescript
import { CODESIFT_INSTRUCTIONS } from "./instructions.js";

const server = new McpServer(
  { name: "codesift-mcp", version: "0.1.0" },
  { instructions: CODESIFT_INSTRUCTIONS }
);
```

### generate_claude_md Enhancement

Extend `generate_claude_md` tool to include behavioral guidance (hint codes, discovery flow) alongside the existing architecture section. When called, it produces a complete CLAUDE.md that combines:
1. Existing architecture overview (auto-generated from index)
2. Hint code legend (from instructions.ts)
3. Tool discovery instructions

### Edge Cases

| Case | Handling |
|------|----------|
| User has existing CLAUDE.md | Rules go to `.claude/rules/codesift.md`, NOT to CLAUDE.md. No collision. |
| User has custom `.claude/rules/codesift.md` | Version+hash check. Warn if modified. `--force` to overwrite. |
| Re-run setup after npm update | Version mismatch detected → auto-update if unmodified, warn if modified. |
| Cursor user | `.cursor/rules/codesift.mdc` — Cursor auto-loads from this dir. |
| Codex user | Append to `AGENTS.md` with a `<!-- codesift-rules -->` delimited block. |
| Gemini user | Append to `GEMINI.md` with a delimited block. |
| Platform not supported | MCP instructions still work (universal fallback). |
| User runs `--no-rules --no-hooks` | Only config written (current behavior preserved). |
| Hooks already installed (idempotent) | Existing `setupClaudeHooks` already checks by matcher. |
| Re-run setup codex/gemini (append mode) | Find `<!-- codesift-rules-start -->` / `<!-- codesift-rules-end -->` delimiters in AGENTS.md/GEMINI.md. Replace block in-place. If no delimiters found, append new block with delimiters. |
| `rules/` dir missing from npm package | Graceful fallback: generate rules from `CODESIFT_INSTRUCTIONS` string. |

## Acceptance Criteria

**Must have:**
1. MCP `instructions` field populated in server.ts — every client receives ~800 tok guidance on connect
2. `codesift setup claude` writes `.claude/rules/codesift.md` with full tool mapping + params + hints
3. `codesift setup claude` installs PreToolUse + PostToolUse hooks (existing setupClaudeHooks)
4. `codesift setup cursor` writes `.cursor/rules/codesift.mdc`
5. `codesift setup codex` appends to `AGENTS.md`
6. `codesift setup gemini` appends to `GEMINI.md`
7. `--no-rules` flag skips rules installation
8. `--no-hooks` flag skips hooks installation
9. `--force` flag overwrites modified rules files
10. Re-run detects version mismatch and updates unmodified rules
11. `rules/` directory included in npm package (`files` field)
12. Bug fix: `commands.ts` parses and passes flags to `setup()`
13. `generate_claude_md` includes behavioral guidance (hints, discovery) alongside architecture

**Should have:**
14. Setup output lists every file written with full paths
15. Hash-based modification detection on rules files
16. Post-install npm script prints "Run `codesift setup <platform>` to complete installation"

## Out of Scope

- Claude Code plugin distribution (requires separate marketplace)
- Dynamic Jinja2 templates (Serena approach — too complex for now)
- `audit_agent_config` tool (jcodemunch feature — separate spec)
- Rules auto-update without re-running setup
- Windsurf / Continue / Aider specific rules formats (covered by MCP instructions as fallback)

## Open Questions

None — all resolved.
