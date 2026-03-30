#!/usr/bin/env python3
"""
CodeSift vs jCodeMunch — head-to-head benchmark on same repos, same queries.
Measures tool output tokens (chars/4) and time.

Run: python3 benchmarks/codesift-vs-jcodemunch.py
"""
import json, time, sys, os

# jcodemunch imports
from jcodemunch_mcp.server import (
    search_text as jcm_search_text,
    search_symbols as jcm_search_symbols,
    get_file_outline as jcm_get_file_outline,
    get_file_tree as jcm_get_file_tree,
    find_references as jcm_find_references,
    find_dead_code as jcm_find_dead_code,
    get_context_bundle as jcm_get_context_bundle,
    get_repo_outline as jcm_get_repo_outline,
    get_dependency_graph as jcm_get_dependency_graph,
    suggest_queries as jcm_suggest_queries,
)

# CodeSift — call via CLI for fair comparison (same MCP overhead)
import subprocess

REPOS = [
    {"cs": "local/codesift-mcp", "jcm": "local/codesift-mcp", "label": "codesift-mcp"},
    {"cs": "local/promptvault", "jcm": "local/promptvault", "label": "promptvault"},
]

def tok(data):
    """Estimate tokens from output data."""
    if isinstance(data, str):
        return len(data) // 4
    s = json.dumps(data, indent=2) if isinstance(data, (dict, list)) else str(data)
    return len(s) // 4

def codesift_cli(cmd):
    """Run codesift CLI and return output + timing."""
    start = time.time()
    try:
        result = subprocess.run(
            ["npx", "codesift"] + cmd,
            capture_output=True, text=True, timeout=30,
            cwd="/Users/greglas/DEV/codesift-mcp"
        )
        output = result.stdout
    except Exception:
        output = ""
    ms = int((time.time() - start) * 1000)
    return output, ms

rows = []

def measure(tool, repo_label, jcm_fn, cs_cmd):
    """Run both tools and compare."""
    # jcodemunch
    start = time.time()
    try:
        jcm_result = jcm_fn()
    except Exception as e:
        jcm_result = {"error": str(e)}
    jcm_ms = int((time.time() - start) * 1000)
    jcm_tok = tok(jcm_result)

    # codesift CLI
    cs_output, cs_ms = codesift_cli(cs_cmd)
    cs_tok = tok(cs_output)

    rows.append({
        "tool": tool, "repo": repo_label,
        "jcm_tok": jcm_tok, "cs_tok": cs_tok,
        "jcm_ms": jcm_ms, "cs_ms": cs_ms,
    })

    diff = "n/a" if jcm_tok == 0 else f"{int((cs_tok - jcm_tok) / jcm_tok * 100):+d}%"
    print(f"  {tool:<25} jcm={jcm_tok:>8} cs={cs_tok:>8} diff={diff:>7}  jcm={jcm_ms:>6}ms cs={cs_ms:>6}ms")


print("CodeSift vs jCodeMunch — Head-to-Head Benchmark")
print("=" * 80)

for repo in REPOS:
    print(f"\nrepo: {repo['label']}")
    print(f"  {'tool':<25} {'jcm_tok':>8} {'cs_tok':>8} {'diff':>7}  {'jcm_ms':>8} {'cs_ms':>8}")
    print(f"  {'-'*25} {'-'*8} {'-'*8} {'-'*7}  {'-'*8} {'-'*8}")

    r_jcm = repo["jcm"]
    r_cs = repo["cs"]

    # 1. search_text
    measure("search_text", repo["label"],
        lambda: jcm_search_text(r_jcm, "TODO"),
        ["search", r_cs, "TODO", "--compact"])

    # 2. search_symbols
    measure("search_symbols", repo["label"],
        lambda: jcm_search_symbols(r_jcm, "create", kind="function"),
        ["symbols", r_cs, "create", "--kind", "function", "--compact"])

    # 3. get_file_outline
    measure("get_file_outline", repo["label"],
        lambda: jcm_get_file_outline(r_jcm, "src/types.ts"),
        ["outline", r_cs, "--file", "src/types.ts"])

    # 4. get_file_tree
    measure("get_file_tree", repo["label"],
        lambda: jcm_get_file_tree(r_jcm),
        ["tree", r_cs, "--compact"])

    # 5. find_references
    measure("find_references", repo["label"],
        lambda: jcm_find_references(r_jcm, "searchText"),
        ["refs", r_cs, "searchText", "--compact"])

    # 6. get_context_bundle
    measure("get_context_bundle", repo["label"],
        lambda: jcm_get_context_bundle(r_jcm, "searchText"),
        ["search", r_cs, "searchText", "--compact"])

    # 7. get_repo_outline
    measure("get_repo_outline", repo["label"],
        lambda: jcm_get_repo_outline(r_jcm),
        ["tree", r_cs, "--compact"])

    # 8. suggest_queries
    measure("suggest_queries", repo["label"],
        lambda: jcm_suggest_queries(r_jcm),
        ["search", r_cs, "suggest", "--compact"])

    # 9. find_dead_code
    measure("find_dead_code", repo["label"],
        lambda: jcm_find_dead_code(r_jcm),
        ["search", r_cs, "dead", "--compact"])

# Summary
print("\n" + "=" * 80)
print("SUMMARY")
print(f"  {'tool':<25} {'jcm_tok':>8} {'cs_tok':>8} {'diff':>7}")
print(f"  {'-'*25} {'-'*8} {'-'*8} {'-'*7}")

tools = list(dict.fromkeys(r["tool"] for r in rows))
total_jcm = 0
total_cs = 0
for tool in tools:
    tr = [r for r in rows if r["tool"] == tool]
    j = sum(r["jcm_tok"] for r in tr)
    c = sum(r["cs_tok"] for r in tr)
    total_jcm += j
    total_cs += c
    diff = "n/a" if j == 0 else f"{int((c - j) / j * 100):+d}%"
    winner = "CS" if c < j else "JCM" if j < c else "TIE"
    print(f"  {tool:<25} {j:>8} {c:>8} {diff:>7}  {winner}")

diff = f"{int((total_cs - total_jcm) / total_jcm * 100):+d}%" if total_jcm > 0 else "n/a"
print(f"  {'TOTAL':<25} {total_jcm:>8} {total_cs:>8} {diff:>7}")

# Save
os.makedirs("benchmarks/results", exist_ok=True)
stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
outpath = f"benchmarks/results/codesift-vs-jcodemunch-{stamp}.json"
with open(outpath, "w") as f:
    json.dump({"rows": rows, "startedAt": stamp}, f, indent=2)
print(f"\nsaved: {outpath}")
