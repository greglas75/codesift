import type { ToolRecommendation } from "../../search/tool-ranker.js";
import { capQuery } from "./query-parser.js";
import type { FileRecommendation, PlanTurnResult, SymbolRecommendation } from "./types.js";

const FORMAT_TOOL_LIMIT = 10;
const FORMAT_SYMBOL_LIMIT = 10;
const FORMAT_FILE_LIMIT = 5;

function resolveTools(result: PlanTurnResult): ToolRecommendation[] {
  if (result.tools.length > 0) return result.tools.slice(0, FORMAT_TOOL_LIMIT);
  return [{
    name: "discover_tools",
    confidence: 0.3,
    reasoning: "No direct matches, try explicit search",
    is_hidden: false,
  }];
}

function appendGapAnalysis(lines: string[], result: PlanTurnResult): boolean {
  if (!result.gap_analysis) return false;
  lines.push("\n⛔ STOP_AND_REPORT_GAP");
  lines.push(`prior_query: ${capQuery(result.gap_analysis.prior_query)}`);
  lines.push(`prior_result_count: ${result.gap_analysis.prior_result_count}`);
  lines.push(`suggestion: ${result.gap_analysis.suggestion}`);
  return true;
}

function appendTools(lines: string[], tools: ToolRecommendation[]): void {
  lines.push(`\n─── Tools (${tools.length}) ───`);
  for (const tool of tools) {
    const hidden = tool.is_hidden ? " [hidden]" : "";
    lines.push(`  ${tool.name}${hidden}  confidence: ${tool.confidence.toFixed(3)}`);
    lines.push(`    ${tool.reasoning}`);
  }
}

function appendToolMetadata(lines: string[], result: PlanTurnResult): void {
  if (result.already_used.length > 0) {
    lines.push(`\n─── Already Used (${result.already_used.length}) ───`);
    lines.push(`  ${result.already_used.join(", ")}`);
  }
  if (result.reveal_required.length > 0) {
    lines.push(`\n─── Reveal Required (${result.reveal_required.length}) ───`);
    lines.push("  These tools are hidden — call describe_tools(names=[...]) to reveal:");
    lines.push(`  ${result.reveal_required.join(", ")}`);
  }
}

function appendSymbols(lines: string[], symbols: SymbolRecommendation[]): void {
  if (symbols.length === 0) return;
  lines.push(`\n─── Symbols (${symbols.length}) ───`);
  for (const symbol of symbols) {
    lines.push(`  ${symbol.kind} ${symbol.name}  ${symbol.file}:${symbol.line}`);
  }
}

function appendFiles(lines: string[], files: FileRecommendation[]): void {
  if (files.length === 0) return;
  lines.push(`\n─── Files (${files.length}) ───`);
  for (const file of files) {
    lines.push(`  ${file.path}  score: ${file.score.toFixed(2)}  (${file.reason})`);
  }
}

function appendFlags(lines: string[], result: PlanTurnResult): void {
  const flags: string[] = [];
  if (result.metadata.vague_query) flags.push("vague_query");
  if (result.metadata.stale_index) flags.push("stale_index");
  if (result.metadata.framework_mismatch) flags.push("framework_mismatch");
  if (result.metadata.cold_start) flags.push("cold_start");
  if (flags.length === 0) return;
  lines.push("\n─── Flags ───");
  lines.push(`  ${flags.join(", ")}`);
}

export function formatPlanTurnResult(result: PlanTurnResult): string {
  const lines = [
    `plan_turn: ${capQuery(result.query)}`,
    `confidence: ${result.confidence.toFixed(3)} | duration: ${result.metadata.duration_ms}ms`,
  ];
  if (appendGapAnalysis(lines, result)) return lines.join("\n");

  appendTools(lines, resolveTools(result));
  appendToolMetadata(lines, result);
  appendSymbols(lines, result.symbols.slice(0, FORMAT_SYMBOL_LIMIT));
  appendFiles(lines, result.files.slice(0, FORMAT_FILE_LIMIT));
  appendFlags(lines, result);
  return lines.join("\n");
}
