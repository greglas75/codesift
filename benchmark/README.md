# CodeSift Benchmark Framework

Pluggable benchmark framework for comparing code search tools.
Runs universal tasks against real repos, measures tokens/time/calls per tool.

## Quick Start

```bash
# 1. Run benchmarks (CodeSift vs ripgrep on one repo)
python scripts/run_benchmark.py --repo shield --adapter codesift,ripgrep

# 2. Run single category
python scripts/run_benchmark.py --adapter codesift --task-filter category=analysis

# 3. Dry run (see what would execute)
python scripts/run_benchmark.py --dry-run

# 4. List all tasks
python scripts/run_benchmark.py --list-tasks

# 5. Generate gold answers for a repo
python scripts/generate_gold.py --repo shield

# 6. Run full benchmark across all repos
python scripts/run_benchmark.py
```

## Structure

```
benchmark/
├── config.yaml              # Repos, adapters, metrics, limits
├── tasks/
│   └── universal_tasks.yaml  # 30 tasks that work on ANY repo
├── adapters/
│   ├── base.py               # ToolAdapter interface + ToolCall/TaskResult
│   ├── codesift.py           # CodeSift CLI adapter
│   ├── ripgrep.py            # Ripgrep adapter (baseline)
│   └── _template.py          # Copy to add new tool in 5 min
├── gold/
│   └── {repo_id}/            # Generated gold answers per repo
│       └── {task_id}.json
├── scripts/
│   ├── run_benchmark.py      # Main runner
│   └── generate_gold.py      # Gold answer generator
├── results/                  # Raw JSON/JSONL results
└── reports/                  # Markdown comparison reports
```

## Adding a New Tool (5 minutes)

```bash
# 1. Copy template
cp adapters/_template.py adapters/sourcegraph.py

# 2. Edit: set adapter_id, implement strategies
#    Only implement categories your tool supports.

# 3. Register in config.yaml
adapters:
  - id: sourcegraph
    module: adapters.sourcegraph
    class: SourcegraphAdapter
    description: "Sourcegraph code search"
    requires_index: true

# 4. Run
python scripts/run_benchmark.py --adapter sourcegraph --repo shield
```

## What Gets Measured

### Per Task
- `wall_clock_ms` — total time from start to answer
- `tool_calls` — number of command invocations
- `total_output_chars` — characters in all outputs
- `total_output_tokens` — estimated tokens (chars / 4)
- `success` — did it find the right answer?
- `precision` / `recall` / `f1` — for set-match tasks

### Per Tool Call (within a task)
- `call_wall_clock_ms` — time for THIS specific call
- `call_output_chars` — characters THIS call returned
- `call_output_tokens` — tokens THIS call consumed
- `call_command` — exact command executed
- `call_returncode` — exit code

### Report Output
- Summary by adapter (avg tokens, time, success rate)
- Breakdown by category (text, symbol, analysis, etc.)
- Per-task comparison table
- Per-call detail (which commands each tool used)

## Task Design

Tasks are **universal** — same question for every repo:
- "Find all empty catch blocks"
- "Trace the main POST endpoint from handler to database write"
- "Find copy-pasted code blocks"

Agent adapts to whatever repo it's pointed at.
Gold answers are generated per-repo using `generate_gold.py`.

### Task Categories (30 tasks)

| Category | Tasks | What it measures |
|----------|------:|-----------------|
| text | 5 | Pattern search: TODOs, env vars, anti-patterns |
| symbol | 5 | Function/type lookup: auth, validators, factories |
| structure | 4 | File organization: dirs, routes, complexity |
| retrieval | 4 | Code reading: DB config, error handler, settings |
| relationship | 5 | Call chains, impact analysis, circular deps |
| semantic | 4 | Architecture questions: auth, errors, pipeline |
| analysis | 3 | Dead code, clones, hotspots (CodeSift differentiators) |

## Gold Answers

Two modes:

**auto** — `generate_gold.py` runs CodeSift, stores output.
Human reviews and sets `"verified": true` before using in scoring.

**fixed** — you write the gold answer manually (for tasks where you know the exact answer).

```json
// gold/shield/text-001.json
{
  "task_id": "text-001",
  "repo_id": "shield",
  "verified": true,
  "raw_output": "...",
  "result_count": 5,
  "notes": "Verified: 5 TODOs in production code, 3 in src/services, 2 in src/utils"
}
```

## Repos

Configured in `config.yaml`. Currently:

| ID | Language | Framework | Size |
|----|----------|-----------|------|
| shield | TypeScript | CF Workers | large |
| offer-module | TypeScript | NestJS | large |
| mobi | PHP | Yii2 | large |
| data-lab | Python | Flask | medium |
| tgm-platform | TypeScript | NestJS | large |
| translation-qa | TypeScript | Vite | medium |

## Dependencies

```bash
pip install pyyaml   # only dependency
```
