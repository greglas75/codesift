import { traceCallChain } from "../src/tools/graph-tools.js";
import { getCodeIndex } from "../src/tools/index-tools.js";
import { formatCallTree } from "../src/formatters.js";

async function main() {
  await getCodeIndex("local/codesift-mcp");
  for (const q of ["searchText", "loadConfig", "getCodeIndex", "buildBM25Index"]) {
    try {
      const r = await traceCallChain("local/codesift-mcp", q, "callers", { depth: 2 });
      const json = JSON.stringify(r, null, 2);
      const text = formatCallTree(r as never);
      const jsonTok = Math.ceil(json.length / 4);
      const textTok = Math.ceil(text.length / 4);
      const textLines = text.split("\n").length;

      // Count nodes in tree
      let nodes = 0;
      function countNodes(n: unknown): void { nodes++; const ch = (n as {children?: unknown[]}).children ?? []; ch.forEach(countNodes); }
      countNodes(r);

      console.log(`${q.padEnd(20)} nodes=${String(nodes).padStart(4)} json=${String(jsonTok).padStart(6)} text=${String(textTok).padStart(6)} saved=${Math.round((1 - textTok/jsonTok) * 100)}% lines=${textLines}`);
    } catch { console.log(`${q.padEnd(20)} not found`); }
  }
}
main();
