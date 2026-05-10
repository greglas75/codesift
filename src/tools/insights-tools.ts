import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { UsageEntry } from "../storage/usage-tracker.js";
import { getUsagePath } from "../storage/usage-tracker.js";

export interface UsageFilters {
  since?: string;
  repo?: string;
  tool?: string;
  session_id?: string;
  limit?: number;
}

export interface RetroFilters {
  project?: string;
  skill?: string;
  friction_category?: string;
  since?: string;
  limit?: number;
  zuvo_dir?: string;
}

export interface InsightCandidate {
  kind: "tool_optimization" | "skill_gap" | "memory_candidate" | "routing_rule" | "missing_template";
  title: string;
  content: string;
  repo?: string;
  scope: "global_team" | "repo_team";
  confidence: number;
  impact_score: number;
  source: "usage" | "retro" | "analysis";
  evidence: Array<Record<string, unknown>>;
  suggested_action?: Record<string, unknown>;
}

interface RetroEntry {
  ts: number;
  project: string;
  skill: string;
  code_type?: string;
  friction_category?: string;
  missing_template?: string;
  context_gap?: string;
  turns_wasted: number;
  tool_calls: number;
  files_read: number;
  files_modified: number;
  branch?: string;
  sha7?: string;
  blind_audit?: string;
  adversarial?: string;
  codesift?: string;
  routing_status?: string;
  markdown_body?: string;
  proposals?: Array<{ rank: number; content: string }>;
  source_ref: string;
}

const RETRO_LOG_COLUMNS = [
  "date",
  "skill",
  "project",
  "code_type",
  "friction_category",
  "missing_template",
  "context_gap",
  "turns_wasted",
  "tool_calls",
  "files_read",
  "files_modified",
  "branch",
  "sha7",
  "blind_audit",
  "adversarial",
  "codesift",
  "routing_status",
];

function parseNumber(value: unknown): number {
  const match = String(value ?? "").match(/-?\d+/);
  return match ? Number(match[0]) : 0;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function sinceTs(since?: string): number {
  return since ? parseTimestamp(since) : 0;
}

function redact(text: string): string {
  return text
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]");
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function loadUsageEntries(filters: UsageFilters = {}): Promise<UsageEntry[]> {
  const raw = await readText(getUsagePath());
  const minTs = sinceTs(filters.since);
  const entries: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as UsageEntry;
      if (!entry || typeof entry.tool !== "string" || typeof entry.ts !== "number") continue;
      if (entry.ts < minTs) continue;
      if (filters.repo && entry.repo !== filters.repo) continue;
      if (filters.tool && entry.tool !== filters.tool) continue;
      if (filters.session_id && entry.session_id !== filters.session_id) continue;
      entries.push(entry);
    } catch {
      // ignore malformed lines
    }
  }
  return entries.sort((a, b) => a.ts - b.ts);
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const arr = map.get(key) ?? [];
    arr.push(item);
    map.set(key, arr);
  }
  return map;
}

export async function usageHotspots(filters: UsageFilters = {}) {
  const entries = await loadUsageEntries(filters);
  const byTool = [...groupBy(entries, (e) => e.tool).entries()].map(([tool, rows]) => {
    const elapsed = rows.reduce((sum, row) => sum + (row.elapsed_ms || 0), 0);
    const tokens = rows.reduce((sum, row) => sum + (row.result_tokens || 0), 0);
    return {
      tool,
      calls: rows.length,
      avg_elapsed_ms: Math.round(elapsed / Math.max(rows.length, 1)),
      max_elapsed_ms: Math.max(...rows.map((row) => row.elapsed_ms || 0)),
      total_tokens: tokens,
      avg_tokens: Math.round(tokens / Math.max(rows.length, 1)),
    };
  });
  const slow_tools = byTool
    .filter((row) => row.calls >= 3)
    .sort((a, b) => b.avg_elapsed_ms - a.avg_elapsed_ms)
    .slice(0, 15);
  const token_heavy_tools = byTool
    .filter((row) => row.calls >= 3)
    .sort((a, b) => b.avg_tokens - a.avg_tokens)
    .slice(0, 15);

  const repeated_calls: Array<Record<string, unknown>> = [];
  const bySession = groupBy(entries, (e) => e.session_id || "unknown");
  for (const [session_id, rows] of bySession) {
    const sorted = rows.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      const sameArgs = JSON.stringify(prev.args_summary || {}) === JSON.stringify(cur.args_summary || {});
      if (prev.tool === cur.tool && prev.repo === cur.repo && sameArgs && cur.ts - prev.ts <= 60_000) {
        repeated_calls.push({
          session_id,
          tool: cur.tool,
          repo: cur.repo,
          delta_ms: cur.ts - prev.ts,
          args_summary: cur.args_summary,
        });
      }
    }
  }

  const recommendations = [
    ...slow_tools.filter((row) => row.avg_elapsed_ms >= 1000).slice(0, 5).map((row) => ({
      kind: "latency",
      tool: row.tool,
      message: `${row.tool} averages ${row.avg_elapsed_ms}ms; review caching, batching, or narrower defaults.`,
    })),
    ...token_heavy_tools.filter((row) => row.avg_tokens >= 1800).slice(0, 5).map((row) => ({
      kind: "token_output",
      tool: row.tool,
      message: `${row.tool} averages ${row.avg_tokens} result tokens; add compact/counts modes or lower default limits.`,
    })),
    ...(repeated_calls.length ? [{
      kind: "duplicate_calls",
      tool: "multiple",
      message: `${repeated_calls.length} repeated calls within 60s; add debounce hints or response-cache coverage.`,
    }] : []),
  ];

  return {
    usage_path: getUsagePath(),
    total_entries: entries.length,
    slow_tools,
    token_heavy_tools,
    repeated_calls: repeated_calls.slice(0, 50),
    recommendations,
  };
}

export async function usageTraceSession(options: { session_id: string; limit?: number }) {
  const entries = await loadUsageEntries({ session_id: options.session_id });
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  return {
    session_id: options.session_id,
    calls: entries.slice(0, limit).map((entry, index) => ({
      index,
      ts: entry.ts,
      iso_time: new Date(entry.ts).toISOString(),
      tool: entry.tool,
      repo: entry.repo,
      elapsed_ms: entry.elapsed_ms,
      result_tokens: entry.result_tokens,
      result_chunks: entry.result_chunks,
      args_summary: entry.args_summary,
    })),
  };
}

function zuvoDir(custom?: string): string {
  return custom || join(homedir(), ".zuvo");
}

function extractSection(body: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`### ${escaped}\\n([\\s\\S]*?)(?=\\n### |\\n<!-- RETRO -->|$)`, "i"));
  return match ? match[1]!.trim() : "";
}

function extractProposals(body: string): Array<{ rank: number; content: string }> {
  const section = extractSection(body, "Change Proposals (ranked by impact, up to 5)");
  if (!section) return [];
  const proposals: Array<{ rank: number; content: string }> = [];
  const re = /\*\*(\d+)\.\*\*\s+([\s\S]*?)(?=\n\*\*\d+\.\*\*|\n\*\*Impact ranking:|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(section))) {
    proposals.push({ rank: Number(match[1]), content: redact(match[2]!.trim().slice(0, 2400)) });
  }
  return proposals;
}

async function parseRetrosLog(file: string): Promise<RetroEntry[]> {
  const raw = await readText(file);
  const retros: RetroEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const clean = trimmed.startsWith("RETRO:") ? trimmed.replace(/^RETRO:\s*/, "") : trimmed;
    const parts = clean.split("\t");
    if (parts.length < 3) continue;
    const row: Record<string, string> = {};
    RETRO_LOG_COLUMNS.forEach((key, index) => { row[key] = parts[index] ?? ""; });
    retros.push({
      ts: parseTimestamp(row["date"]),
      project: row["project"] || "",
      skill: row["skill"] || "",
      code_type: row["code_type"] || "",
      friction_category: row["friction_category"] || "",
      missing_template: row["missing_template"] || "",
      context_gap: row["context_gap"] || "",
      turns_wasted: parseNumber(row["turns_wasted"]),
      tool_calls: parseNumber(row["tool_calls"]),
      files_read: parseNumber(row["files_read"]),
      files_modified: parseNumber(row["files_modified"]),
      branch: row["branch"] || "",
      sha7: row["sha7"] || "",
      blind_audit: row["blind_audit"] || "",
      adversarial: row["adversarial"] || "",
      codesift: row["codesift"] || "",
      routing_status: row["routing_status"] || "",
      source_ref: file,
    });
  }
  return retros;
}

async function parseRetrosMarkdown(file: string): Promise<RetroEntry[]> {
  const raw = await readText(file);
  const blocks = raw.split("<!-- RETRO -->").map((block) => block.trim()).filter(Boolean);
  const retros: RetroEntry[] = [];
  for (const body of blocks) {
    const header = body.match(/^## \[([^\]]+)\] \[([^\]]+)\] \[([^\]]+)\](?: \[([^\]]+)\])?/m);
    if (!header) continue;
    const friction = extractSection(body, "Friction");
    const cost = extractSection(body, "Session Cost");
    retros.push({
      ts: parseTimestamp(header[1]),
      skill: header[2] || "",
      project: header[3] || "",
      friction_category: friction ? "markdown-retro" : "",
      turns_wasted: parseNumber(friction.match(/Most turns:\*\*([^\n]+)/i)?.[1]),
      tool_calls: parseNumber(cost.match(/Tool calls:\*\*([^\n]+)/i)?.[1]),
      files_read: parseNumber(cost.match(/Files read:\*\*([^\n]+)/i)?.[1]),
      files_modified: parseNumber(cost.match(/Files modified:\*\*([^\n]+)/i)?.[1]),
      markdown_body: redact(body.slice(0, 8000)),
      proposals: extractProposals(body),
      source_ref: file,
    });
  }
  return retros;
}

async function loadRetros(filters: RetroFilters = {}): Promise<RetroEntry[]> {
  const dir = zuvoDir(filters.zuvo_dir);
  const files = [
    join(dir, "retros.log"),
    join(dir, "retros.md"),
  ].filter((file) => existsSync(file) && statSync(file).isFile());
  const minTs = sinceTs(filters.since);
  const all: RetroEntry[] = [];
  for (const file of files) {
    const rows = file.endsWith(".md") ? await parseRetrosMarkdown(file) : await parseRetrosLog(file);
    all.push(...rows);
  }
  return all
    .filter((row) => row.ts >= minTs)
    .filter((row) => !filters.project || row.project === filters.project)
    .filter((row) => !filters.skill || row.skill === filters.skill)
    .filter((row) => !filters.friction_category || row.friction_category === filters.friction_category)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.max(1, Math.min(filters.limit ?? 100, 500)));
}

export async function retrosList(filters: RetroFilters = {}) {
  const rows = await loadRetros(filters);
  return {
    zuvo_dir: zuvoDir(filters.zuvo_dir),
    total: rows.length,
    retrospectives: rows,
  };
}

export async function retrosAnalyze(filters: RetroFilters = {}) {
  const rows = await loadRetros({ ...filters, limit: filters.limit ?? 500 });
  const byFriction = [...groupBy(rows, (r) => r.friction_category || "unknown").entries()]
    .map(([friction_category, items]) => ({
      friction_category,
      count: items.length,
      turns_wasted: items.reduce((sum, item) => sum + item.turns_wasted, 0),
      tool_calls: items.reduce((sum, item) => sum + item.tool_calls, 0),
    }))
    .sort((a, b) => b.count - a.count);
  const byProject = [...groupBy(rows, (r) => r.project || "unknown").entries()]
    .map(([project, items]) => ({
      project,
      count: items.length,
      turns_wasted: items.reduce((sum, item) => sum + item.turns_wasted, 0),
    }))
    .sort((a, b) => b.count - a.count);
  const missingTemplates = [...groupBy(rows.filter((r) => r.missing_template && r.missing_template !== "-"), (r) => r.missing_template || "unknown").entries()]
    .map(([missing_template, items]) => ({ missing_template, count: items.length }))
    .sort((a, b) => b.count - a.count);
  return {
    zuvo_dir: zuvoDir(filters.zuvo_dir),
    total: rows.length,
    by_friction: byFriction,
    by_project: byProject,
    missing_templates: missingTemplates,
  };
}

function candidateFromUsage(row: { tool: string; calls: number; avg_elapsed_ms: number; avg_tokens: number }): InsightCandidate | null {
  if (row.calls < 3) return null;
  if (row.avg_elapsed_ms < 1000 && row.avg_tokens < 1800) return null;
  return {
    kind: "tool_optimization",
    title: `Optimize CodeSift ${row.tool}`,
    content: `${row.tool} is a usage hotspot: ${row.calls} calls, ${row.avg_elapsed_ms}ms average latency, ${row.avg_tokens} average result tokens.`,
    scope: "global_team",
    confidence: 78,
    impact_score: Math.min(100, Math.round(row.calls * 2 + row.avg_elapsed_ms / 100 + row.avg_tokens / 100)),
    source: "usage",
    evidence: [
      { source: "codesift_usage", metric: "calls", value: row.calls },
      { source: "codesift_usage", metric: "avg_elapsed_ms", value: row.avg_elapsed_ms },
      { source: "codesift_usage", metric: "avg_tokens", value: row.avg_tokens },
    ],
    suggested_action: { target: "codesift-mcp", summary: `Review ${row.tool} defaults, caching, compact output, and routing hints.` },
  };
}

function candidateFromRetro(row: { friction_category: string; count: number; turns_wasted: number }): InsightCandidate | null {
  if (!row.friction_category || row.friction_category === "-" || row.count < 2) return null;
  return {
    kind: row.friction_category.includes("template") ? "missing_template" : "skill_gap",
    title: `Reduce ${row.friction_category} friction`,
    content: `Zuvo retros show ${row.count} sessions with ${row.friction_category} friction and ${row.turns_wasted} wasted turns.`,
    scope: "global_team",
    confidence: 78,
    impact_score: Math.min(100, row.count * 12 + row.turns_wasted * 8),
    source: "retro",
    evidence: [
      { source: "zuvo_retros", metric: "sessions", value: row.count },
      { source: "zuvo_retros", metric: "turns_wasted", value: row.turns_wasted },
      { source: "zuvo_retros", metric: "friction_category", value: row.friction_category },
    ],
    suggested_action: { target: "zuvo-skills", summary: `Add or update a reusable rule for ${row.friction_category}.` },
  };
}

export async function memoryCandidateExtract(filters: UsageFilters & RetroFilters = {}) {
  const retros = await loadRetros({ ...filters, limit: filters.limit ?? 100 });
  const candidates: InsightCandidate[] = [];
  for (const retro of retros) {
    for (const proposal of retro.proposals ?? []) {
      candidates.push({
        kind: "memory_candidate",
        title: `Retro proposal: ${retro.skill || "skill"} / ${retro.project || "project"}`,
        content: proposal.content,
        repo: retro.project,
        scope: "repo_team",
        confidence: Math.max(60, 85 - proposal.rank * 5),
        impact_score: Math.max(30, 90 - proposal.rank * 8),
        source: "retro",
        evidence: [{ source: "zuvo_retros", sourceRef: retro.source_ref, ts: retro.ts, rank: proposal.rank }],
        suggested_action: { target: "PopeMemory", summary: "Promote if this is durable project/team knowledge." },
      });
    }
  }
  return {
    total: candidates.length,
    candidates: candidates.slice(0, Math.max(1, Math.min(filters.limit ?? 50, 200))),
  };
}

export async function optimizationCandidates(filters: UsageFilters & RetroFilters = {}) {
  const [usage, retros] = await Promise.all([
    usageHotspots(filters),
    retrosAnalyze(filters),
  ]);
  const candidates = [
    ...usage.slow_tools.map(candidateFromUsage).filter((c): c is InsightCandidate => Boolean(c)),
    ...usage.token_heavy_tools.map(candidateFromUsage).filter((c): c is InsightCandidate => Boolean(c)),
    ...retros.by_friction.map(candidateFromRetro).filter((c): c is InsightCandidate => Boolean(c)),
  ];
  const deduped = new Map<string, InsightCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.title}`;
    const existing = deduped.get(key);
    if (!existing || candidate.impact_score > existing.impact_score) deduped.set(key, candidate);
  }
  return {
    generated_at: new Date().toISOString(),
    candidates: [...deduped.values()].sort((a, b) => b.impact_score - a.impact_score),
  };
}

function insightsBase(server: string): string {
  const base = server.replace(/\/$/, "");
  if (base.endsWith("/api/insights")) return base;
  if (base.endsWith("/api")) return `${base}/insights`;
  return `${base}/api/insights`;
}

export async function popeInsightsPushCandidates(options: {
  server?: string;
  api_key?: string;
  dry_run?: boolean;
  since?: string;
  repo?: string;
  zuvo_dir?: string;
}) {
  const generated = await optimizationCandidates(options);
  const payload = {
    source: {
      sourceType: "codesift_analysis",
      sourcePath: getUsagePath(),
      host: hostname(),
      metadata: { zuvo_dir: zuvoDir(options.zuvo_dir) },
    },
    candidates: generated.candidates,
  };
  if (options.dry_run !== false) {
    return { dry_run: true, payload };
  }
  if (!options.server || !options.api_key) {
    throw new Error("pope_insights_push_candidates requires server and api_key when dry_run=false");
  }
  const res = await fetch(`${insightsBase(options.server)}/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": options.api_key,
      "x-pope-insights-client": "codesift-mcp",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`PopeInsights push failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}
