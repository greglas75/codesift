import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfigAuditResult {
  config_path: string;
  token_cost: number;
  stale_symbols: Array<{ symbol: string; line: number }>;
  dead_paths: Array<{ path: string; line: number }>;
  redundant_blocks: Array<{ text: string; found_in: string[] }>;
  findings: string[];
}

// ---------------------------------------------------------------------------
// Regex extractors
// ---------------------------------------------------------------------------

const SYMBOL_RE = /`([A-Za-z_]\w{2,})`/g;
const FILE_PATH_RE = /\b([\w./-]+\.(?:ts|js|tsx|jsx|py|go|rs|md|json|yaml|yml|toml))\b/g;

export function extractSymbolRefs(text: string): string[] {
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = SYMBOL_RE.exec(text)) !== null) {
    if (match[1]) results.push(match[1]);
  }
  return results;
}

export function extractFilePaths(text: string): string[] {
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    if (match[1]) results.push(match[1]);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Redundancy detection
// ---------------------------------------------------------------------------

function findRedundantBlocks(
  contentA: string,
  pathA: string,
  contentB: string,
  pathB: string,
  minLines: number = 5,
): Array<{ text: string; found_in: string[] }> {
  const linesA = contentA.split("\n");
  const linesB = contentB.split("\n");

  // Build a map of consecutive line blocks from file B
  const blockMap = new Map<string, boolean>();
  for (let i = 0; i <= linesB.length - minLines; i++) {
    const block = linesB.slice(i, i + minLines).join("\n");
    blockMap.set(block, true);
  }

  // Find blocks in A that also appear in B
  const seen = new Set<string>();
  const results: Array<{ text: string; found_in: string[] }> = [];
  for (let i = 0; i <= linesA.length - minLines; i++) {
    const block = linesA.slice(i, i + minLines).join("\n");
    if (blockMap.has(block) && !seen.has(block)) {
      seen.add(block);
      results.push({ text: block, found_in: [pathA, pathB] });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export async function auditAgentConfig(
  repo: string,
  options?: { config_path?: string; compare_with?: string },
): Promise<AgentConfigAuditResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`No index found for repo "${repo}". Run index_folder first.`);
  }

  const configPath = options?.config_path ?? join(index.root, "CLAUDE.md");
  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
      throw new Error(`Config file not found: ${configPath}`);
    }
    throw err;
  }

  // Build lookup sets from the index
  const symbolNames = new Set(index.symbols.map((s) => s.name));
  const filePaths = new Set(index.files.map((f) => f.path));

  const lines = content.split("\n");
  const staleSymbols: Array<{ symbol: string; line: number }> = [];
  const deadPaths: Array<{ path: string; line: number }> = [];
  const findings: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i]!;

    // Check symbols on this line
    for (const sym of extractSymbolRefs(line)) {
      if (!symbolNames.has(sym)) {
        staleSymbols.push({ symbol: sym, line: lineNum });
      }
    }

    // Check file paths on this line
    for (const p of extractFilePaths(line)) {
      if (!filePaths.has(p)) {
        deadPaths.push({ path: p, line: lineNum });
      }
    }
  }

  const tokenCost = Math.ceil(content.length / 3.5);

  if (staleSymbols.length > 0) {
    findings.push(`${staleSymbols.length} stale symbol reference(s) found`);
  }
  if (deadPaths.length > 0) {
    findings.push(`${deadPaths.length} dead file path(s) found`);
  }
  findings.push(`Estimated token cost: ${tokenCost} tokens per agent turn`);

  const result: AgentConfigAuditResult = {
    config_path: configPath,
    token_cost: tokenCost,
    stale_symbols: staleSymbols,
    dead_paths: deadPaths,
    redundant_blocks: [],
    findings,
  };

  // Redundancy detection
  if (options?.compare_with) {
    const compareContent = await readFile(options.compare_with, "utf-8");
    result.redundant_blocks = findRedundantBlocks(
      content,
      configPath,
      compareContent,
      options.compare_with,
    );
    if (result.redundant_blocks.length > 0) {
      findings.push(`${result.redundant_blocks.length} redundant block(s) found between files`);
    }
  }

  return result;
}
