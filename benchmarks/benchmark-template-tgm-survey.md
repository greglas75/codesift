# Benchmark Template: tgm-survey-platform

**Project**: tgm-survey-platform (NestJS, TypeScript, Prisma, monorepo)
**Index size**: ~60,610 symbols / 4,080 files
**Repo**: local/tgm-survey-platform

---

## Tasks (T1-T18)

| ID | Task | Type | Tool |
|----|------|------|------|
| T1 | Find `SurveyService.create` definition + params + return type | Find function | codebase_retrieval |
| T2 | Find ALL files importing from `QuestionsService` | Find usages | codebase_retrieval |
| T3 | Find `CreateSurveyDto` fields | Understand type | codebase_retrieval |
| T4 | Trace `AuthGuard` middleware logic | Trace middleware | codebase_retrieval |
| T5 | Find all Zod/class-validator schemas in survey module | Find pattern | codebase_retrieval |
| T6 | Analyze `NavigationService` methods + dependencies | Service analysis | codebase_retrieval |
| T7 | Find `SURVEY_NOT_FOUND` or equivalent error + all throw sites | Error codes | codebase_retrieval |
| T8 | List all survey API routes + HTTP methods | API routes | codebase_retrieval |
| T9 | Find all `prisma.$transaction` usages | Cross-cutting | codebase_retrieval |
| T10 | Trace survey runner pipeline (start → navigate → complete) | Architecture trace | codebase_retrieval (semantic) |
| T11 | Find dead/unused exports in `apps/api/src` | Dead code | find_dead_code |
| T12 | Find top 5 most complex functions | Complexity | analyze_complexity |
| T13 | Check for circular dependencies in `apps/api/src` | Circular deps | get_knowledge_map |
| T14 | Generate Mermaid diagram of `RunnerService` callees depth 2 | Visualization | trace_call_chain (mermaid) |
| T15 | Find code clones (>70% similarity) in `apps/api/src` | Clone detection | find_clones |
| T16 | Find git churn hotspots in last 90 days | Hotspot analysis | analyze_hotspots |
| T17 | Search for `empty-catch` anti-pattern | Pattern search | search_patterns |
| T18 | Get context bundle for `SurveyService` (symbol + imports + types) | Context bundle | get_context_bundle |

---

## R43 Baseline (2026-03-16)

| Metric | R43 |
|--------|-----|
| Total tokens | 108,485 |
| Quality | ~9.0/18 |
| Tool calls | 25 |
| Duration | 219s |
| T16 (hotspots) | 0/10 — shallow clone, no git history |
| T13 (circular deps) | 5/10 — knowledge_map too large to confirm |
| Notable | T12: validateQuestion complexity=92. T15: 11 clone pairs. T17: 0 empty catches in 36K symbols |
