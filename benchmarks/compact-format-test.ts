import { getSymbol, formatSymbolCompact, getContextBundle, formatBundleCompact } from "../src/tools/symbol-tools.js";
import { getCodeIndex } from "../src/tools/index-tools.js";
import { searchSymbols } from "../src/tools/search-tools.js";

async function main() {
  const repos = [
    { id: "local/codesift-mcp", label: "codesift-mcp" },
    { id: "local/translation-qa", label: "translation-qa" },
    { id: "local/promptvault", label: "promptvault" },
  ];

  console.log("=== get_symbol: JSON vs Compact ===\n");
  const queries = ["searchText", "create", "config", "parse", "render", "validate", "export", "process"];

  for (const repo of repos) {
    await getCodeIndex(repo.id);
    console.log(`repo: ${repo.label}`);
    console.log("query           json_tok  compact_tok  saved");
    let totalJson = 0, totalCompact = 0;

    for (const q of queries) {
      const results = await searchSymbols(repo.id, q, { top_k: 1, include_source: false, detail_level: "compact" });
      if (!results[0]) continue;
      const sym = await getSymbol(repo.id, results[0].symbol.id);
      if (!sym) continue;
      const jsonTok = Math.ceil(JSON.stringify(sym, null, 2).length / 4);
      const compactTok = Math.ceil(formatSymbolCompact(sym).length / 4);
      totalJson += jsonTok;
      totalCompact += compactTok;
      console.log(`${q.padEnd(15)} ${String(jsonTok).padStart(8)} ${String(compactTok).padStart(12)} ${String(Math.round((1 - compactTok / jsonTok) * 100)).padStart(5)}%`);
    }
    console.log(`TOTAL           ${String(totalJson).padStart(8)} ${String(totalCompact).padStart(12)} ${String(Math.round((1 - totalCompact / totalJson) * 100)).padStart(5)}%\n`);
  }

  console.log("=== get_context_bundle: JSON vs Compact ===\n");
  const bundleQueries = ["searchText", "getFileTree", "buildBM25Index", "processPayment", "createRisk"];

  for (const repo of repos) {
    console.log(`repo: ${repo.label}`);
    console.log("query           json_tok  compact_tok  saved");
    let totalJson = 0, totalCompact = 0;

    for (const q of bundleQueries) {
      const bundle = await getContextBundle(repo.id, q);
      if (!bundle) continue;
      const jsonTok = Math.ceil(JSON.stringify(bundle, null, 2).length / 4);
      const compactTok = Math.ceil(formatBundleCompact(bundle).length / 4);
      totalJson += jsonTok;
      totalCompact += compactTok;
      console.log(`${q.padEnd(15)} ${String(jsonTok).padStart(8)} ${String(compactTok).padStart(12)} ${String(Math.round((1 - compactTok / jsonTok) * 100)).padStart(5)}%`);
    }
    console.log(`TOTAL           ${String(totalJson).padStart(8)} ${String(totalCompact).padStart(12)} ${String(Math.round((1 - totalCompact / totalJson) * 100)).padStart(5)}%\n`);
  }
}
main();
