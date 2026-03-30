
import { searchText } from '../src/tools/search-tools.js';
import { searchSymbols } from '../src/tools/search-tools.js';
import { getFileOutline, getFileTree, getRepoOutline, suggestQueries } from '../src/tools/outline-tools.js';
import { findReferences, findDeadCode, getContextBundle } from '../src/tools/symbol-tools.js';
import { formatSearchSymbols, formatFileTree, formatFileOutline, formatRepoOutline, formatSuggestQueries, formatDeadCode } from '../src/formatters.js';
import { formatRefsCompact, formatBundleCompact } from '../src/tools/symbol-tools.js';
import { getCodeIndex } from '../src/tools/index-tools.js';

const repos = ["local/codesift-mcp", "local/promptvault"];
const tools = [["search_text", {"query": "TODO"}], ["search_text", {"query": "async function"}], ["search_symbols", {"query": "create", "kind": "function"}], ["search_symbols", {"query": "handle"}], ["get_file_outline", {"file_path": "src/types.ts"}], ["get_file_tree", {}], ["find_references", {"symbol": "searchText"}], ["find_references", {"symbol": "loadConfig"}], ["find_dead_code", {}], ["get_context_bundle", {"symbol": "searchText"}], ["get_repo_outline", {}], ["suggest_queries", {}]];
const results: Record<string, Record<string, {tok:number, ms:number}>> = {};

async function measure(repo: string, tool: string, fn: () => Promise<string>): Promise<void> {
  const t = performance.now();
  let out = "";
  try { out = await fn(); } catch { }
  if (!results[repo]) results[repo] = {};
  const key = tool + "_" + Object.values(tools.find(t => t[0] === tool)?.[1] ?? {}).join("_");
  results[repo][key] = { tok: Math.ceil(out.length/4), ms: Math.round(performance.now()-t) };
}

async function main() {
  for (const repo of repos) await getCodeIndex(repo);

  for (const repo of repos) {
    for (const [tool, kw] of tools) {
      const q = (kw as any).query ?? "";
      const sym = (kw as any).symbol ?? "";
      const fp = (kw as any).file_path ?? "";
      const kind = (kw as any).kind;

      if (tool === "search_text") {
        await measure(repo, tool + "_" + q, async () => {
          const r = await searchText(repo, q, { auto_group: true });
          return typeof r === "string" ? r : JSON.stringify(r);
        });
      } else if (tool === "search_symbols") {
        await measure(repo, tool + "_" + q, async () => {
          const r = await searchSymbols(repo, q, { kind, top_k: 10 });
          return formatSearchSymbols(r);
        });
      } else if (tool === "get_file_outline") {
        await measure(repo, tool, async () => {
          const r = await getFileOutline(repo, fp);
          return formatFileOutline(r as never);
        });
      } else if (tool === "get_file_tree") {
        await measure(repo, tool, async () => {
          const r = await getFileTree(repo, { compact: true });
          return formatFileTree(r as never);
        });
      } else if (tool === "find_references") {
        await measure(repo, tool + "_" + sym, async () => {
          const r = await findReferences(repo, sym);
          return formatRefsCompact(r);
        });
      } else if (tool === "find_dead_code") {
        await measure(repo, tool, async () => {
          const r = await findDeadCode(repo, {});
          return formatDeadCode(r as never);
        });
      } else if (tool === "get_context_bundle") {
        await measure(repo, tool, async () => {
          const r = await getContextBundle(repo, sym);
          return r ? formatBundleCompact(r) : "";
        });
      } else if (tool === "get_repo_outline") {
        await measure(repo, tool, async () => {
          const r = await getRepoOutline(repo);
          return formatRepoOutline(r as never);
        });
      } else if (tool === "suggest_queries") {
        await measure(repo, tool, async () => {
          const r = await suggestQueries(repo);
          return formatSuggestQueries(r as never);
        });
      }
    }
  }
  console.log(JSON.stringify(results));
}
main();
