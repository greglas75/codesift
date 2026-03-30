#!/usr/bin/env python3
"""
Benchmark Scorer
================

Compares benchmark results against gold answers.
Computes precision, recall, F1 for set-type tasks,
and rubric scores for rubric-type tasks.

Usage:
  python scripts/score.py results/benchmark_20260328_120000.json
  python scripts/score.py results/benchmark_20260328_120000.json --gold-dir gold/
  python scripts/score.py results/benchmark_20260328_120000.json --update  # write scores back
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent


def load_results(results_path: str) -> list[dict]:
    with open(results_path) as f:
        return json.load(f)


def load_gold(repo_id: str, task_id: str, gold_dir: str = "gold/") -> dict | None:
    """Load gold answer for a specific repo+task."""
    gold_path = ROOT / gold_dir / repo_id / f"{task_id}.json"
    if not gold_path.exists():
        return None
    with open(gold_path) as f:
        data = json.load(f)
    if not data.get("verified", False):
        return None  # only use verified gold
    return data


def load_task(task_id: str, tasks_path: str = "tasks/universal_tasks.yaml") -> dict | None:
    """Load task definition by ID."""
    import yaml
    with open(ROOT / tasks_path) as f:
        data = yaml.safe_load(f)
    for task in data.get("tasks", []):
        if task["id"] == task_id:
            return task
    return None


def normalize_path(path: str) -> str:
    """Normalize a file path for comparison (strip leading ./, lowercase)."""
    path = path.strip().lstrip("./")
    return path


def extract_file_paths(output: str) -> set[str]:
    """Extract file paths from tool output.

    Handles common formats:
      ./src/foo.ts:42: ...
      src/foo.ts:42
      src/foo.ts
    """
    paths = set()
    for line in output.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        # Match file:line patterns
        match = re.match(r'^([^\s:]+\.[a-zA-Z0-9]+)(?::\d+)?', line)
        if match:
            paths.add(normalize_path(match.group(1)))
    return paths


def score_set(result: dict, gold: dict) -> dict:
    """Score a set-type task: compare found items against gold set.

    Returns precision, recall, F1.
    """
    gold_output = gold.get("raw_output", "")
    result_output = result.get("raw_output", "")

    if not result_output:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0, "method": "set_file_paths"}

    gold_paths = extract_file_paths(gold_output)
    result_paths = extract_file_paths(result_output)

    if not gold_paths:
        # Gold has no parseable paths — fall back to line count comparison
        gold_count = gold.get("result_count", 0)
        result_count = result.get("result_count", 0)
        if gold_count == 0:
            return {"precision": 0.0, "recall": 0.0, "f1": 0.0, "method": "no_gold_data"}

        # Approximate: ratio of found vs expected
        ratio = min(result_count / gold_count, 1.0) if gold_count > 0 else 0.0
        return {"precision": ratio, "recall": ratio, "f1": ratio, "method": "count_ratio"}

    # Compute precision and recall
    true_positives = gold_paths & result_paths
    precision = len(true_positives) / len(result_paths) if result_paths else 0.0
    recall = len(true_positives) / len(gold_paths) if gold_paths else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0

    return {
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "f1": round(f1, 3),
        "true_positives": len(true_positives),
        "false_positives": len(result_paths - gold_paths),
        "false_negatives": len(gold_paths - result_paths),
        "method": "set_file_paths",
    }


def score_exact_location(result: dict, gold: dict) -> dict:
    """Score exact_location tasks: did we find the right file+function?"""
    gold_output = gold.get("raw_output", "")
    result_output = result.get("raw_output", "")

    if not result_output:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0, "method": "exact_location"}

    gold_paths = extract_file_paths(gold_output)
    result_paths = extract_file_paths(result_output)

    # For exact_location, we check if any gold file appears in results
    found = bool(gold_paths & result_paths) if gold_paths else False

    # Also check if gold contains specific symbol names we can grep for
    score = 1.0 if found else 0.0

    return {
        "precision": score,
        "recall": score,
        "f1": score,
        "found_target": found,
        "method": "exact_location",
    }


def score_rubric(result: dict, gold: dict, task: dict) -> dict:
    """Score rubric tasks: check if required points are addressed.

    Simple keyword-based check — not LLM graded (that would be a separate step).
    """
    rubric = task.get("rubric", {})
    required_points = rubric.get("required_points", [])
    output = result.get("raw_output", "").lower()

    if not output or not required_points:
        return {"rubric_score": 0.0, "points_found": 0, "points_total": len(required_points), "method": "rubric_keyword"}

    points_found = 0
    for point in required_points:
        # Extract keywords from rubric point (simplified keyword matching)
        keywords = [w.lower() for w in point.split() if len(w) > 3]
        # Check if at least half the keywords appear in output
        matches = sum(1 for kw in keywords if kw in output)
        if matches >= len(keywords) * 0.5:
            points_found += 1

    score = points_found / len(required_points) if required_points else 0.0

    return {
        "rubric_score": round(score, 3),
        "points_found": points_found,
        "points_total": len(required_points),
        "precision": round(score, 3),
        "recall": round(score, 3),
        "f1": round(score, 3),
        "method": "rubric_keyword",
    }


def score_graph(result: dict, gold: dict) -> dict:
    """Score graph tasks: check if call chain includes expected nodes.

    Simplified: extract function/symbol names from both outputs and compare overlap.
    """
    gold_output = gold.get("raw_output", "")
    result_output = result.get("raw_output", "")

    if not result_output:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0, "method": "graph_symbol_overlap"}

    # Extract likely symbol names (camelCase or snake_case identifiers)
    def extract_symbols(text: str) -> set[str]:
        # Match identifiers that look like function/class names
        return set(re.findall(r'\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b', text))

    gold_syms = extract_symbols(gold_output)
    result_syms = extract_symbols(result_output)

    # Filter out very common words
    noise = {"function", "class", "const", "export", "import", "return", "async", "await",
             "from", "string", "number", "boolean", "null", "undefined", "true", "false",
             "this", "self", "new", "type", "interface", "void", "any"}
    gold_syms -= noise
    result_syms -= noise

    if not gold_syms:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0, "method": "no_gold_symbols"}

    overlap = gold_syms & result_syms
    precision = len(overlap) / len(result_syms) if result_syms else 0.0
    recall = len(overlap) / len(gold_syms) if gold_syms else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0

    return {
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "f1": round(f1, 3),
        "symbols_overlap": len(overlap),
        "method": "graph_symbol_overlap",
    }


def score_result(result: dict, gold_dir: str = "gold/") -> dict:
    """Score a single benchmark result against its gold answer."""
    task_id = result.get("task_id", "")
    repo_id = result.get("repo_id", "")

    gold = load_gold(repo_id, task_id, gold_dir)
    if not gold:
        return {"scored": False, "reason": "no_verified_gold"}

    task = load_task(task_id)
    if not task:
        return {"scored": False, "reason": "task_not_found"}

    eval_type = task.get("evaluation_type", "set")

    # Load raw_output from result if stored separately
    # (the runner stores it in the full result, not the summary)

    if eval_type == "set":
        scores = score_set(result, gold)
    elif eval_type == "exact_location":
        scores = score_exact_location(result, gold)
    elif eval_type == "rubric":
        scores = score_rubric(result, gold, task)
    elif eval_type == "graph":
        scores = score_graph(result, gold)
    else:
        return {"scored": False, "reason": f"unknown_eval_type: {eval_type}"}

    scores["scored"] = True
    scores["eval_type"] = eval_type
    return scores


def score_all(results: list[dict], gold_dir: str = "gold/") -> list[dict]:
    """Score all results and return enriched results."""
    scored_results = []
    scored_count = 0
    total_f1 = 0.0

    for r in results:
        scores = score_result(r, gold_dir)
        enriched = {**r, "scores": scores}

        if scores.get("scored"):
            enriched["precision"] = scores.get("precision", 0.0)
            enriched["recall"] = scores.get("recall", 0.0)
            enriched["f1"] = scores.get("f1", 0.0)
            scored_count += 1
            total_f1 += scores.get("f1", 0.0)

        scored_results.append(enriched)

    avg_f1 = total_f1 / scored_count if scored_count > 0 else 0.0
    print(f"\nScored {scored_count}/{len(results)} results. Avg F1: {avg_f1:.3f}")

    return scored_results


def main():
    parser = argparse.ArgumentParser(description="Score benchmark results against gold answers")
    parser.add_argument("results_path", help="Path to benchmark results JSON")
    parser.add_argument("--gold-dir", default="gold/", help="Gold answers directory")
    parser.add_argument("--update", action="store_true", help="Write scores back to results file")
    args = parser.parse_args()

    results = load_results(args.results_path)
    scored = score_all(results, args.gold_dir)

    if args.update:
        with open(args.results_path, "w") as f:
            json.dump(scored, f, indent=2, default=str)
        print(f"Updated: {args.results_path}")
    else:
        # Print summary
        print(f"\n{'Task':<20} {'Adapter':<12} {'Repo':<15} {'F1':>6} {'P':>6} {'R':>6} {'Method'}")
        print("-" * 85)
        for r in scored:
            s = r.get("scores", {})
            if s.get("scored"):
                print(
                    f"{r['task_id']:<20} {r.get('adapter_id', ''):<12} {r.get('repo_id', ''):<15} "
                    f"{s.get('f1', 0):.3f}  {s.get('precision', 0):.3f}  {s.get('recall', 0):.3f}  "
                    f"{s.get('method', '')}"
                )
            else:
                print(
                    f"{r['task_id']:<20} {r.get('adapter_id', ''):<12} {r.get('repo_id', ''):<15} "
                    f"{'—':>6} {'—':>6} {'—':>6}  {s.get('reason', 'no gold')}"
                )


if __name__ == "__main__":
    main()
