#!/usr/bin/env python3
"""
CodeSift vs jCodeMunch — fair benchmark.
Both called as library imports. Same repos, same queries, fresh indexes.

Run: python3 benchmarks/codesift-vs-jcodemunch-v2.py
"""
import json, time, os, subprocess

from jcodemunch_mcp.server import (
    search_text as jcm_search_text,
    search_symbols as jcm_search_symbols,
    get_file_outline as jcm_get_file_outline,
    get_file_tree as jcm_get_file_tree,
    find_references as jcm_find_references,
    find_dead_code as jcm_find_dead_code,
    get_context_bundle as jcm_get_context_bundle,
    get_repo_outline as jcm_get_repo_outline,
    suggest_queries as jcm_suggest_queries,
)

REPOS = [
    {"cs": "local/codesift-mcp", "jcm": "local/codesift-mcp-e3ca9abd", "label": "codesift-mcp"},
    {"cs": "local/promptvault", "jcm": "local/promptvault-936d9a3b", "label": "promptvault"},
]

TOOLS = [
    ("search_text",      {"query": "TODO"}),
    ("search_text",      {"query": "async function"}),
    ("search_symbols",   {"query": "create", "kind": "function"}),
    ("search_symbols",   {"query": "handle"}),
    ("get_file_outline", {"file_path": "src/types.ts"}),
    ("get_file_tree",    {}),
    ("find_references",  {"symbol": "searchText"}),
    ("find_references",  {"symbol": "loadConfig"}),
    ("find_dead_code",   {}),
    ("get_context_bundle", {"symbol": "searchText"}),
    ("get_repo_outline", {}),
    ("suggest_queries",  {}),
]

def tok(data):
    if isinstance(data, str): return len(data) // 4
    return len(json.dumps(data)) // 4

def run_jcm(tool, repo, **kw):
    fns = {
        "search_text": lambda: jcm_search_text(repo, kw.get("query", "")),
        "search_symbols": lambda: jcm_search_symbols(repo, kw.get("query", ""), kind=kw.get("kind")),
        "get_file_outline": lambda: jcm_get_file_outline(repo, kw.get("file_path", "")),
        "get_file_tree": lambda: jcm_get_file_tree(repo),
        "find_references": lambda: jcm_find_references(repo, kw.get("symbol", "")),
        "find_dead_code": lambda: jcm_find_dead_code(repo),
        "get_context_bundle": lambda: jcm_get_context_bundle(repo, kw.get("symbol", "")),
        "get_repo_outline": lambda: jcm_get_repo_outline(repo),
        "suggest_queries": lambda: jcm_suggest_queries(repo),
    }
    start = time.time()
    try:
        result = fns[tool]()
        t = tok(result)
    except Exception as e:
        t = tok(str(e))
    ms = int((time.time() - start) * 1000)
    return t, ms

# Build CodeSift batch script dynamically
def build_cs_script():
    repos_cs = json.dumps([r["cs"] for r in REPOS])
    tools_json = json.dumps(TOOLS)

    return f"""
import {{ searchText }} from '../src/tools/search-tools.js';
import {{ searchSymbols }} from '../src/tools/search-tools.js';
import {{ getFileOutline, getFileTree, getRepoOutline, suggestQueries }} from '../src/tools/outline-tools.js';
import {{ findReferences, findDeadCode, getContextBundle }} from '../src/tools/symbol-tools.js';
import {{ formatSearchSymbols, formatFileTree, formatFileOutline, formatRepoOutline, formatSuggestQueries, formatDeadCode }} from '../src/formatters.js';
import {{ formatRefsCompact, formatBundleCompact }} from '../src/tools/symbol-tools.js';
import {{ getCodeIndex }} from '../src/tools/index-tools.js';

const repos = {repos_cs};
const tools = {tools_json};
const results: Record<string, Record<string, {{tok:number, ms:number}}>> = {{}};

async function measure(repo: string, tool: string, fn: () => Promise<string>): Promise<void> {{
  const t = performance.now();
  let out = "";
  try {{ out = await fn(); }} catch {{ }}
  if (!results[repo]) results[repo] = {{}};
  const key = tool + "_" + Object.values(tools.find(t => t[0] === tool)?.[1] ?? {{}}).join("_");
  results[repo][key] = {{ tok: Math.ceil(out.length/4), ms: Math.round(performance.now()-t) }};
}}

async function main() {{
  for (const repo of repos) await getCodeIndex(repo);

  for (const repo of repos) {{
    for (const [tool, kw] of tools) {{
      const q = (kw as any).query ?? "";
      const sym = (kw as any).symbol ?? "";
      const fp = (kw as any).file_path ?? "";
      const kind = (kw as any).kind;

      if (tool === "search_text") {{
        await measure(repo, tool + "_" + q, async () => {{
          const r = await searchText(repo, q, {{ auto_group: true }});
          return typeof r === "string" ? r : JSON.stringify(r);
        }});
      }} else if (tool === "search_symbols") {{
        await measure(repo, tool + "_" + q, async () => {{
          const r = await searchSymbols(repo, q, {{ kind, top_k: 10 }});
          return formatSearchSymbols(r);
        }});
      }} else if (tool === "get_file_outline") {{
        await measure(repo, tool, async () => {{
          const r = await getFileOutline(repo, fp);
          return formatFileOutline(r as never);
        }});
      }} else if (tool === "get_file_tree") {{
        await measure(repo, tool, async () => {{
          const r = await getFileTree(repo, {{ compact: true }});
          return formatFileTree(r as never);
        }});
      }} else if (tool === "find_references") {{
        await measure(repo, tool + "_" + sym, async () => {{
          const r = await findReferences(repo, sym);
          return formatRefsCompact(r);
        }});
      }} else if (tool === "find_dead_code") {{
        await measure(repo, tool, async () => {{
          const r = await findDeadCode(repo, {{}});
          return formatDeadCode(r as never);
        }});
      }} else if (tool === "get_context_bundle") {{
        await measure(repo, tool, async () => {{
          const r = await getContextBundle(repo, sym);
          return r ? formatBundleCompact(r) : "";
        }});
      }} else if (tool === "get_repo_outline") {{
        await measure(repo, tool, async () => {{
          const r = await getRepoOutline(repo);
          return formatRepoOutline(r as never);
        }});
      }} else if (tool === "suggest_queries") {{
        await measure(repo, tool, async () => {{
          const r = await suggestQueries(repo);
          return formatSuggestQueries(r as never);
        }});
      }}
    }}
  }}
  console.log(JSON.stringify(results));
}}
main();
"""

print("CodeSift vs jCodeMunch — Fair Benchmark (both as library imports)")
print("=" * 90)

# Run CodeSift batch
print("\nRunning CodeSift batch...")
script_path = os.path.join(os.path.dirname(__file__), "_cs-batch-runner.ts")
with open(script_path, "w") as f:
    f.write(build_cs_script())

result = subprocess.run(
    ["npx", "tsx", script_path],
    capture_output=True, text=True, timeout=120,
    cwd="/Users/greglas/DEV/codesift-mcp",
)

cs_all = {}
for line in result.stdout.strip().split("\n"):
    line = line.strip()
    if line.startswith("{"):
        try: cs_all = json.loads(line)
        except: pass

if not cs_all:
    print("CS ERROR:", result.stderr[:300] if result.stderr else "(no output)")

rows = []

for repo_def in REPOS:
    label = repo_def["label"]
    jcm_repo = repo_def["jcm"]
    cs_repo = repo_def["cs"]
    cs_data = cs_all.get(cs_repo, {})

    print(f"\nrepo: {label}")
    print(f"  {'query':<30} {'jcm':>6} {'cs':>6} {'diff':>7}  {'jcm_ms':>6} {'cs_ms':>6}")
    print(f"  {'-'*30} {'-'*6} {'-'*6} {'-'*7}  {'-'*6} {'-'*6}")

    for tool, kw in TOOLS:
        q = kw.get("query", kw.get("symbol", kw.get("file_path", "")))
        key = tool + "_" + q if q else tool

        jcm_tok, jcm_ms = run_jcm(tool, jcm_repo, **kw)
        # Try exact key, then with trailing underscore (JS script adds it)
        cs_entry = cs_data.get(key) or cs_data.get(key + "_") or cs_data.get(key.rstrip("_")) or {"tok": 0, "ms": 0}
        cs_tok, cs_ms = cs_entry["tok"], cs_entry["ms"]

        diff = "n/a" if jcm_tok == 0 else f"{int((cs_tok - jcm_tok) / jcm_tok * 100):+d}%"
        print(f"  {key:<30} {jcm_tok:>6} {cs_tok:>6} {diff:>7}  {jcm_ms:>5}ms {cs_ms:>5}ms")

        rows.append({"tool": tool, "query": key, "repo": label, "jcm_tok": jcm_tok, "cs_tok": cs_tok, "jcm_ms": jcm_ms, "cs_ms": cs_ms})

# Summary per tool type
print(f"\n{'=' * 90}")
print("SUMMARY BY TOOL")
print(f"  {'tool':<25} {'jcm':>8} {'cs':>8} {'diff':>7} {'winner':>7}")
print(f"  {'-'*25} {'-'*8} {'-'*8} {'-'*7} {'-'*7}")

tool_names = list(dict.fromkeys(t for t, _ in TOOLS))
total_jcm = total_cs = cs_wins = jcm_wins = 0

for tool in tool_names:
    tr = [r for r in rows if r["tool"] == tool]
    j = sum(r["jcm_tok"] for r in tr)
    c = sum(r["cs_tok"] for r in tr)
    total_jcm += j; total_cs += c
    diff = "n/a" if j == 0 else f"{int((c - j) / j * 100):+d}%"
    w = "CS" if c < j else "JCM" if j < c else "TIE"
    if c < j: cs_wins += 1
    elif j < c: jcm_wins += 1
    print(f"  {tool:<25} {j:>8} {c:>8} {diff:>7} {w:>7}")

diff = f"{int((total_cs - total_jcm) / total_jcm * 100):+d}%" if total_jcm > 0 else "n/a"
print(f"  {'TOTAL':<25} {total_jcm:>8} {total_cs:>8} {diff:>7}")
print(f"\n  CodeSift wins: {cs_wins}/{len(tool_names)}  jCodeMunch wins: {jcm_wins}/{len(tool_names)}")

stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
outpath = f"benchmarks/results/cs-vs-jcm-{stamp}.json"
os.makedirs("benchmarks/results", exist_ok=True)
with open(outpath, "w") as f:
    json.dump({"rows": rows}, f, indent=2)
print(f"\nsaved: {outpath}")
