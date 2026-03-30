#!/usr/bin/env python3
"""
Gold Answer Generator
=====================

Runs each task against a repo using CodeSift and stores the output
as the expected "gold" answer. Human reviews and approves.

Usage:
  python scripts/generate_gold.py --repo shield
  python scripts/generate_gold.py --repo shield --task-filter category=text
  python scripts/generate_gold.py --repo all

Output:
  gold/{repo_id}/{task_id}.json

After generation, review gold files manually and mark verified:
  "verified": true
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

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from adapters.base import ToolAdapter


def load_config() -> dict:
    with open(ROOT / "config.yaml") as f:
        return yaml.safe_load(f)


def load_tasks() -> list[dict]:
    with open(ROOT / "tasks" / "universal_tasks.yaml") as f:
        data = yaml.safe_load(f)
    return data.get("tasks", [])


def load_adapter(config: dict) -> ToolAdapter:
    """Load the gold generation adapter (CodeSift by default)."""
    gold_adapter_id = config.get("gold", {}).get("generation_adapter", "codesift")
    adapter_config = next(a for a in config["adapters"] if a["id"] == gold_adapter_id)
    module = importlib.import_module(adapter_config["module"])
    cls = getattr(module, adapter_config["class"])
    return cls()


def generate_gold_for_repo(
    adapter: ToolAdapter,
    repo: dict,
    tasks: list[dict],
    task_filter: str | None = None,
):
    """Generate gold answers for all applicable tasks in a repo."""
    repo_id = repo["id"]
    repo_path = repo["path"]
    gold_dir = ROOT / "gold" / repo_id
    os.makedirs(gold_dir, exist_ok=True)

    # Filter tasks
    repo_tags = repo.get("tags", [])
    applicable = []
    for task in tasks:
        required = task.get("tags_required", [])
        if required and not all(t in repo_tags for t in required):
            continue
        if task.get("gold_mode") != "auto":
            continue
        applicable.append(task)

    if task_filter:
        key, value = task_filter.split("=", 1)
        applicable = [t for t in applicable if str(t.get(key, "")) == value]

    print(f"\nGenerating gold for {repo_id}: {len(applicable)} tasks")
    print(f"Output: {gold_dir}")

    # Setup adapter
    try:
        adapter.setup(repo_path)
    except Exception as e:
        print(f"  Setup failed: {e}")
        return

    for task in applicable:
        task_id = task["id"]
        gold_file = gold_dir / f"{task_id}.json"

        # Skip if already verified
        if gold_file.exists():
            existing = json.loads(gold_file.read_text())
            if existing.get("verified"):
                print(f"  [{task_id}] already verified — skip")
                continue

        print(f"  [{task_id}] generating...", end=" ", flush=True)

        try:
            result = adapter.execute_task(repo_path, task)

            gold_data = {
                "task_id": task_id,
                "repo_id": repo_id,
                "generated_at": datetime.now().isoformat(),
                "generator": adapter.adapter_id,
                "verified": False,  # ← human must set to true
                "question": task["question"],
                "category": task["category"],
                "raw_output": result.raw_output[:10000],  # truncate
                "result_count": result.result_count,
                "wall_clock_ms": result.wall_clock_ms,
                "tokens": result.total_output_tokens,
                "success": result.success,
                "notes": "",  # ← human adds notes during review
            }

            with open(gold_file, "w") as f:
                json.dump(gold_data, f, indent=2, default=str)

            print(f"✓ ({result.wall_clock_ms}ms, {result.total_output_tokens} tokens)")

        except Exception as e:
            print(f"✗ ({e})")
            gold_data = {
                "task_id": task_id,
                "repo_id": repo_id,
                "generated_at": datetime.now().isoformat(),
                "verified": False,
                "error": str(e),
            }
            with open(gold_file, "w") as f:
                json.dump(gold_data, f, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Generate gold answers for benchmark tasks")
    parser.add_argument("--repo", required=True, help="Repo ID or 'all'")
    parser.add_argument("--task-filter", help="Filter: key=value")
    args = parser.parse_args()

    config = load_config()
    tasks = load_tasks()
    adapter = load_adapter(config)

    repos = config["repos"]
    if args.repo != "all":
        repos = [r for r in repos if r["id"] == args.repo]

    for repo in repos:
        generate_gold_for_repo(adapter, repo, tasks, args.task_filter)


if __name__ == "__main__":
    main()
