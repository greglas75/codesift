#!/usr/bin/env python3
"""
CodeSift Benchmark Runner
=========================

Runs universal tasks against repos with pluggable tool adapters.
Measures: tokens, time, tool calls per task AND per individual call.

Usage:
  python scripts/run_benchmark.py
  python scripts/run_benchmark.py --repo codesift-mcp --adapter codesift
  python scripts/run_benchmark.py --adapter ripgrep --task-filter category=text
  python scripts/run_benchmark.py --adapter codesift,ripgrep --repo codesift-mcp
  python scripts/run_benchmark.py --list-tasks
  python scripts/run_benchmark.py --dry-run
"""

import argparse
import importlib
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import yaml

# Add project root to path
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from adapters.base import ToolAdapter, TaskResult


def load_config(config_path: str = "config.yaml") -> dict:
    with open(ROOT / config_path) as f:
        return yaml.safe_load(f)


def load_tasks(tasks_path: str = "tasks/universal_tasks.yaml") -> list[dict]:
    with open(ROOT / tasks_path) as f:
        data = yaml.safe_load(f)
    return data.get("tasks", [])


def load_adapter(adapter_config: dict) -> ToolAdapter:
    """Dynamically load adapter class from config."""
    module = importlib.import_module(adapter_config["module"])
    cls = getattr(module, adapter_config["class"])
    return cls()


def filter_tasks(tasks: list[dict], repo: dict, task_filter: str | None = None) -> list[dict]:
    """Filter tasks by repo tags and optional category filter."""
    filtered = []
    for task in tasks:
        required_tags = task.get("tags_required", [])
        repo_tags = repo.get("tags", [])
        if required_tags and not all(t in repo_tags for t in required_tags):
            continue
        filtered.append(task)

    if task_filter:
        key, value = task_filter.split("=", 1)
        filtered = [t for t in filtered if str(t.get(key, "")) == value]

    return filtered


def run_benchmark(
    config: dict,
    tasks: list[dict],
    repo_ids: list[str] | None = None,
    adapter_ids: list[str] | None = None,
    task_filter: str | None = None,
    dry_run: bool = False,
) -> list[dict]:
    """Main benchmark loop: for each repo x adapter x task -> measure."""
    repos = config["repos"]
    adapters_config = config["adapters"]

    if repo_ids:
        repos = [r for r in repos if r["id"] in repo_ids]
    if adapter_ids:
        adapters_config = [a for a in adapters_config if a["id"] in adapter_ids]

    if not repos:
        print("ERROR: No matching repos found")
        return []
    if not adapters_config:
        print("ERROR: No matching adapters found")
        return []

    # Load adapter instances
    adapters: dict[str, ToolAdapter] = {}
    for ac in adapters_config:
        try:
            adapters[ac["id"]] = load_adapter(ac)
            print(f"  + Loaded adapter: {ac['id']} ({ac['description']})")
        except Exception as e:
            print(f"  x Failed to load adapter {ac['id']}: {e}")

    all_results = []
    total_tasks = 0
    total_start = time.perf_counter()

    for repo in repos:
        repo_id = repo["id"]
        repo_path = repo["path"]

        if not os.path.isdir(repo_path):
            print(f"\n! Repo path not found: {repo_path} -- skipping {repo_id}")
            continue

        repo_tasks = filter_tasks(tasks, repo, task_filter)
        if not repo_tasks:
            print(f"\n! No applicable tasks for {repo_id} -- skipping")
            continue

        print(f"\n{'='*60}")
        print(f"REPO: {repo_id} ({repo['language']}/{repo.get('framework', '?')})")
        print(f"PATH: {repo_path}")
        print(f"TASKS: {len(repo_tasks)}")
        print(f"{'='*60}")

        for adapter_id, adapter in adapters.items():
            print(f"\n  --- Adapter: {adapter_id} ---")

            # Setup (index if needed)
            adapter_config = next(a for a in adapters_config if a["id"] == adapter_id)
            if adapter_config.get("requires_index"):
                try:
                    print(f"  Indexing {repo_id}...", end=" ", flush=True)
                    setup_start = time.perf_counter()
                    adapter.setup(repo_path)
                    setup_ms = int((time.perf_counter() - setup_start) * 1000)
                    print(f"done ({setup_ms}ms)")
                except Exception as e:
                    print(f"FAILED: {e}")
                    continue

            for task in repo_tasks:
                task_id = task["id"]
                total_tasks += 1

                if dry_run:
                    print(f"  [DRY] {task_id} ({task['category']}/{task['difficulty']})")
                    continue

                print(f"  [{total_tasks:3d}] {task_id:<20} ({task['category']:<12}) ", end="", flush=True)

                try:
                    result = adapter.execute_task(repo_path, task)
                    result.repo_id = repo_id
                    result.adapter_id = adapter_id

                    status = "OK" if result.success else "FAIL"
                    print(
                        f"{status:>4}  "
                        f"{result.wall_clock_ms:>5}ms  "
                        f"{result.tool_calls_count}call  "
                        f"{result.total_output_tokens:>5}tok  "
                        f"{result.result_count:>3}items"
                    )

                    result_dict = result.to_dict()
                    # Store raw_output for scoring (truncated for storage)
                    result_dict["raw_output"] = result.raw_output[:20000]
                    all_results.append(result_dict)

                except Exception as e:
                    print(f"ERROR: {e}")
                    all_results.append({
                        "task_id": task_id,
                        "adapter_id": adapter_id,
                        "repo_id": repo_id,
                        "success": False,
                        "error": str(e),
                    })

            try:
                adapter.teardown(repo_path)
            except Exception:
                pass

    total_elapsed = time.perf_counter() - total_start
    print(f"\n{'='*60}")
    print(f"DONE: {total_tasks} task runs in {total_elapsed:.1f}s")
    print(f"{'='*60}")

    return all_results


def save_results(results: list[dict], output_dir: str = "results/"):
    """Save results as JSON + JSONL."""
    os.makedirs(ROOT / output_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    json_path = ROOT / output_dir / f"benchmark_{timestamp}.json"
    with open(json_path, "w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\nResults saved: {json_path}")

    jsonl_path = ROOT / output_dir / f"benchmark_{timestamp}.jsonl"
    with open(jsonl_path, "w") as f:
        for r in results:
            # Don't write raw_output to JSONL (too large)
            slim = {k: v for k, v in r.items() if k != "raw_output"}
            f.write(json.dumps(slim, default=str) + "\n")
    print(f"Results saved: {jsonl_path}")

    return json_path


def generate_report(results: list[dict], config: dict, output_dir: str = "reports/"):
    """Generate markdown comparison report with delta columns."""
    os.makedirs(ROOT / output_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    baseline_id = config.get("reporting", {}).get("baseline_adapter", "ripgrep")

    # Group by adapter
    by_adapter: dict[str, list[dict]] = {}
    for r in results:
        aid = r.get("adapter_id", "unknown")
        by_adapter.setdefault(aid, []).append(r)

    # Group by category
    by_category: dict[str, dict[str, list[dict]]] = {}
    for r in results:
        cat = r.get("task_id", "").split("-")[0] if "-" in r.get("task_id", "") else "unknown"
        aid = r.get("adapter_id", "unknown")
        by_category.setdefault(cat, {}).setdefault(aid, []).append(r)

    # Compute baseline averages for delta calculation
    baseline_cat_tokens: dict[str, int] = {}
    baseline_cat_time: dict[str, int] = {}
    if baseline_id in by_adapter:
        for cat, adapters in by_category.items():
            if baseline_id in adapters:
                bl_results = adapters[baseline_id]
                baseline_cat_tokens[cat] = sum(r.get("total_output_tokens", 0) for r in bl_results)
                baseline_cat_time[cat] = sum(r.get("wall_clock_ms", 0) for r in bl_results)

    report_path = ROOT / output_dir / f"benchmark_report_{timestamp}.md"

    with open(report_path, "w") as f:
        f.write("# CodeSift Benchmark Report\n\n")
        f.write(f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
        f.write(f"**Tasks:** {len(results)}\n")
        f.write(f"**Adapters:** {', '.join(by_adapter.keys())}\n")
        repos_tested = sorted(set(r.get("repo_id", "") for r in results))
        f.write(f"**Repos:** {', '.join(repos_tested)}\n")
        f.write(f"**Baseline:** {baseline_id}\n\n")

        # Summary table
        f.write("## Summary by Adapter\n\n")
        f.write("| Adapter | Tasks | Success | Avg Tokens | Avg Time (ms) | Avg Calls |\n")
        f.write("|---------|-------|---------|------------|---------------|----------|\n")
        for aid, adapter_results in sorted(by_adapter.items()):
            total = len(adapter_results)
            success = sum(1 for r in adapter_results if r.get("success"))
            avg_tokens = sum(r.get("total_output_tokens", 0) for r in adapter_results) // max(total, 1)
            avg_time = sum(r.get("wall_clock_ms", 0) for r in adapter_results) // max(total, 1)
            avg_calls = sum(r.get("tool_calls", 0) for r in adapter_results) // max(total, 1)
            f.write(f"| **{aid}** | {total} | {success}/{total} ({100*success//max(total,1)}%) | {avg_tokens} | {avg_time} | {avg_calls} |\n")
        f.write("\n")

        # Per-category comparison WITH deltas
        f.write("## By Category (with deltas vs baseline)\n\n")
        for cat in sorted(by_category.keys()):
            cat_data = by_category[cat]
            f.write(f"### {cat.upper()}\n\n")
            f.write("| Adapter | Tasks | Success | Total Tokens | vs Baseline | Total Time | vs Baseline | Calls |\n")
            f.write("|---------|-------|---------|-------------|-------------|------------|-------------|-------|\n")
            for aid in sorted(cat_data.keys()):
                cat_results = cat_data[aid]
                total = len(cat_results)
                success = sum(1 for r in cat_results if r.get("success"))
                tot_tokens = sum(r.get("total_output_tokens", 0) for r in cat_results)
                tot_time = sum(r.get("wall_clock_ms", 0) for r in cat_results)
                tot_calls = sum(r.get("tool_calls", 0) for r in cat_results)

                # Delta vs baseline
                bl_tok = baseline_cat_tokens.get(cat, 0)
                bl_time = baseline_cat_time.get(cat, 0)

                if bl_tok > 0 and aid != baseline_id:
                    delta_tok = ((tot_tokens - bl_tok) / bl_tok) * 100
                    delta_tok_str = f"**{delta_tok:+.0f}%**" if delta_tok < 0 else f"+{delta_tok:.0f}%"
                else:
                    delta_tok_str = "baseline" if aid == baseline_id else "—"

                if bl_time > 0 and aid != baseline_id:
                    delta_time = ((tot_time - bl_time) / bl_time) * 100
                    delta_time_str = f"**{delta_time:+.0f}%**" if delta_time < 0 else f"+{delta_time:.0f}%"
                else:
                    delta_time_str = "baseline" if aid == baseline_id else "—"

                f.write(
                    f"| {aid} | {total} | {success}/{total} | {tot_tokens} | {delta_tok_str} "
                    f"| {tot_time}ms | {delta_time_str} | {tot_calls} |\n"
                )
            f.write("\n")

        # Overall delta summary
        if baseline_id in by_adapter and len(by_adapter) > 1:
            f.write("## Overall Token Comparison\n\n")
            f.write("| Category | " + " | ".join(sorted(by_adapter.keys())) + " | Winner |\n")
            f.write("|----------|" + "|".join(["--------"] * len(by_adapter)) + "|--------|\n")

            for cat in sorted(by_category.keys()):
                row = f"| **{cat}** "
                cat_tokens = {}
                for aid in sorted(by_adapter.keys()):
                    tok = sum(r.get("total_output_tokens", 0) for r in by_category.get(cat, {}).get(aid, []))
                    cat_tokens[aid] = tok
                    row += f"| {tok:,} "

                if cat_tokens:
                    winner = min(cat_tokens, key=cat_tokens.get)
                    row += f"| **{winner}** "
                else:
                    row += "| — "
                row += "|\n"
                f.write(row)
            f.write("\n")

        # Per-task detail
        f.write("## Per-Task Detail\n\n")
        f.write("| Task | Adapter | Repo | OK | Tokens | Time (ms) | Calls | Error |\n")
        f.write("|------|---------|------|----|--------|-----------|-------|-------|\n")
        for r in sorted(results, key=lambda x: (x.get("task_id", ""), x.get("adapter_id", ""))):
            status = "Y" if r.get("success") else "N"
            error = r.get("error", "")[:40]
            f.write(
                f"| {r.get('task_id', '')} | {r.get('adapter_id', '')} | {r.get('repo_id', '')} "
                f"| {status} | {r.get('total_output_tokens', 0)} | {r.get('wall_clock_ms', 0)} "
                f"| {r.get('tool_calls', 0)} | {error} |\n"
            )

    print(f"Report saved: {report_path}")
    return report_path


def main():
    parser = argparse.ArgumentParser(description="CodeSift Benchmark Runner")
    parser.add_argument("--config", default="config.yaml", help="Config file path")
    parser.add_argument("--repo", help="Comma-separated repo IDs to test")
    parser.add_argument("--adapter", help="Comma-separated adapter IDs to test")
    parser.add_argument("--task-filter", help="Filter tasks: key=value (e.g., category=text)")
    parser.add_argument("--list-tasks", action="store_true", help="List all tasks and exit")
    parser.add_argument("--dry-run", action="store_true", help="Show what would run without executing")
    parser.add_argument("--no-report", action="store_true", help="Skip report generation")
    args = parser.parse_args()

    config = load_config(args.config)
    tasks = load_tasks()

    if args.list_tasks:
        print(f"\n{'ID':<20} {'Category':<15} {'Difficulty':<10} Question")
        print("-" * 90)
        for t in tasks:
            print(f"{t['id']:<20} {t['category']:<15} {t['difficulty']:<10} {t['question'][:60]}")
        print(f"\nTotal: {len(tasks)} tasks")
        return

    repo_ids = args.repo.split(",") if args.repo else None
    adapter_ids = args.adapter.split(",") if args.adapter else None

    results = run_benchmark(
        config, tasks,
        repo_ids=repo_ids,
        adapter_ids=adapter_ids,
        task_filter=args.task_filter,
        dry_run=args.dry_run,
    )

    if results and not args.dry_run:
        json_path = save_results(results)
        if not args.no_report:
            generate_report(results, config)


if __name__ == "__main__":
    main()
