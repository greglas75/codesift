# Review Queue

Commits pending review. Auto-managed:
- post-commit hook → adds new commits
- `/review` after audit → removes reviewed commits
- `/review mark-reviewed` → removes in bulk

- fb1dd38 (2026-05-05) fix(review/ae96065): apply zuvo:review fix-all (1 MUST-FIX, 6 RECOMMENDED, 2 NIT)
- 29b445b (2026-05-09) 0.6.0
- ce8a9df (2026-05-09) setup(codex): strip per-tool approval_mode overrides on reinstall
- f497eb0 (2026-05-10) docs(plan): usage-driven optimizations from ~/.codesift/usage.jsonl audit
- b2caa19 (2026-05-10) perf(describe_tools): cache schema responses by sorted name set
- 168220d (2026-05-10) perf(hooks): debounce index_file PostToolUse within 2s window
- b76e5fc (2026-05-10) perf(index_folder): short-circuit when watcher active and index <60s
- 9cad3aa (2026-05-10) perf(search): wall-clock caps + identifier auto-rank in search_text
- 5954f48 (2026-05-10) perf(analyze_project): cache profile by index updated_at
- 269259b (2026-05-10) docs(instructions+rules): lead search_text guidance with identifier→ranked
- 948334c (2026-05-10) feat(embeddings): zero-config local provider + task-aware prefixes
- ada7aa2 (2026-05-10) chore(docs): semantic-adoption plan + accumulated review artifacts
