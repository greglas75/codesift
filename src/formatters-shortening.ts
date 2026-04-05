/**
 * Compact and counts formatters for progressive response shortening.
 * Used by registerShortener() to reduce large tool responses.
 */
import { formatTable } from "./formatters.js";

// ── Types (mirrors formatters.ts) ──────────────────

interface ComplexityEntry {
  name: string;
  kind: string;
  file: string;
  start_line: number;
  lines: number;
  cyclomatic_complexity: number;
  max_nesting_depth: number;
}

interface ClonePair {
  symbol_a: { name: string; file: string; start_line: number };
  symbol_b: { name: string; file: string; start_line: number };
  similarity: number;
  shared_lines: number;
}

interface HotspotEntry {
  file: string;
  commits: number;
  lines_changed: number;
  symbol_count: number;
  hotspot_score: number;
}

// ── Analyze complexity ─────────────────────────────

const MAX_COMPLEXITY_COMPACT = 25;

export function formatComplexityCompact(raw: unknown): string {
  const data = raw as { functions: ComplexityEntry[]; summary: Record<string, number> };
  if (data.functions.length === 0) return "(no functions found)";
  const capped = data.functions.slice(0, MAX_COMPLEXITY_COMPACT);
  const rows = capped.map((f) => [
    String(f.cyclomatic_complexity),
    String(f.lines),
    `${f.file}:${f.start_line}`,
    f.name,
  ]);
  return formatTable(["CC", "LINES", "FILE:LINE", "NAME"], rows);
}

export function formatComplexityCounts(raw: unknown): string {
  const data = raw as { functions: ComplexityEntry[]; summary: Record<string, number> };
  const s = data.summary;
  return `${s.total_functions} functions, avg_cc=${s.avg_complexity}, max_cc=${s.max_complexity}`;
}

// ── Find clones ────────────────────────────────────

const MAX_CLONES_COMPACT = 20;

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? filePath;
}

export function formatClonesCompact(raw: unknown): string {
  const data = raw as { clones: ClonePair[]; scanned_symbols: number; threshold: number };
  if (data.clones.length === 0) {
    return `(no clones found, threshold=${data.threshold}, scanned ${data.scanned_symbols} symbols)`;
  }
  const capped = data.clones.slice(0, MAX_CLONES_COMPACT);
  const rows = capped.map((c) => [
    `${Math.round(c.similarity * 100)}%`,
    String(c.shared_lines),
    `${basename(c.symbol_a.file)} ${c.symbol_a.name}`,
    `${basename(c.symbol_b.file)} ${c.symbol_b.name}`,
  ]);
  return formatTable(["SIM%", "SHARED", "SYMBOL_A", "SYMBOL_B"], rows);
}

export function formatClonesCounts(raw: unknown): string {
  const data = raw as { clones: ClonePair[]; scanned_symbols: number; threshold: number };
  return `${data.clones.length} clone pairs (threshold=${data.threshold}, scanned ${data.scanned_symbols})`;
}

// ── Analyze hotspots ───────────────────────────────

const MAX_HOTSPOTS_COMPACT = 15;

export function formatHotspotsCompact(raw: unknown): string {
  const data = raw as { hotspots: HotspotEntry[]; period: string };
  if (data.hotspots.length === 0) return `(no hotspots found, period: ${data.period})`;
  const capped = data.hotspots.slice(0, MAX_HOTSPOTS_COMPACT);
  const rows = capped.map((h) => [
    String(h.hotspot_score),
    String(h.commits),
    h.file,
  ]);
  return formatTable(["SCORE", "COMMITS", "FILE"], rows);
}

export function formatHotspotsCounts(raw: unknown): string {
  const data = raw as { hotspots: HotspotEntry[]; period: string };
  return `${data.hotspots.length} hotspots, period: ${data.period}`;
}
