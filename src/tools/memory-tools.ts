import { readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import {
  searchConversations,
  getClaudeConversationProjectPath,
  type ConversationSearchResult,
} from "./conversation-tools.js";

// ---------------------------------------------------------------------------
// Memory Consolidation — "Dream" system
// ---------------------------------------------------------------------------
// Inspired by Claude Code's autoDream: consolidates scattered conversation
// sessions into durable knowledge files (MEMORY.md). Extracts decisions,
// patterns, solutions, and architectural context from conversation history.
// ---------------------------------------------------------------------------

export interface ConsolidationResult {
  project: string;
  sessions_analyzed: number;
  memories_extracted: number;
  output_path: string;
  categories: Record<string, number>;
  elapsed_ms: number;
}

export interface Memory {
  category: "decision" | "solution" | "pattern" | "architecture" | "gotcha" | "preference";
  summary: string;
  detail: string;
  session_id: string;
  timestamp: string;
  confidence: "high" | "medium" | "low";
}

// Category detection heuristics
const CATEGORY_PATTERNS: Array<{ category: Memory["category"]; patterns: RegExp[] }> = [
  {
    category: "decision",
    patterns: [
      /\b(decided|chose|picked|went with|opted for|switched to|prefer)\b/i,
      /\b(because|reason|rationale|trade-?off|instead of|rather than)\b/i,
      /\b(approach|strategy|design decision)\b/i,
    ],
  },
  {
    category: "solution",
    patterns: [
      /\b(fixed|solved|resolved|workaround|worked|the fix|the solution)\b/i,
      /\b(error|bug|issue|problem|crash|failure|broken)\b/i,
      /\b(EMFILE|ENOENT|EACCES|timeout|memory leak|race condition)\b/i,
    ],
  },
  {
    category: "pattern",
    patterns: [
      /\b(pattern|convention|standard|rule|always|never|must)\b/i,
      /\b(naming|format|style|structure|layout)\b/i,
    ],
  },
  {
    category: "architecture",
    patterns: [
      /\b(architect|module|layer|boundary|service|component)\b/i,
      /\b(dependency|import|export|interface|API|endpoint)\b/i,
      /\b(database|cache|queue|event|middleware)\b/i,
    ],
  },
  {
    category: "gotcha",
    patterns: [
      /\b(gotcha|caveat|careful|watch out|pitfall|trap|footgun)\b/i,
      /\b(don'?t|avoid|beware|warning|note that|important)\b/i,
    ],
  },
  {
    category: "preference",
    patterns: [
      /\b(prefer|like|want|style|convention|format)\b/i,
      /\b(typescript|eslint|prettier|test|framework)\b/i,
    ],
  },
];

function detectCategory(text: string): Memory["category"] {
  let bestCategory: Memory["category"] = "pattern";
  let bestScore = 0;

  for (const { category, patterns } of CATEGORY_PATTERNS) {
    let score = 0;
    for (const p of patterns) {
      if (p.test(text)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  return bestCategory;
}

function detectConfidence(result: ConversationSearchResult): Memory["confidence"] {
  // Higher BM25 score = higher confidence
  if (result.score > 5) return "high";
  if (result.score > 2) return "medium";
  return "low";
}

function extractMemoryFromResult(result: ConversationSearchResult): Memory | null {
  const question = result.user_question?.trim();
  const answer = result.assistant_answer?.trim();

  if (!question || !answer) return null;
  if (question.length < 10 || answer.length < 20) return null;

  const combined = `${question} ${answer}`;
  const category = detectCategory(combined);

  // Create summary from user question
  const summary = question.length > 150 ? question.slice(0, 147) + "..." : question;

  // Create detail from answer
  const detail = answer.length > 500 ? answer.slice(0, 497) + "..." : answer;

  return {
    category,
    summary,
    detail,
    session_id: result.session_id,
    timestamp: result.timestamp,
    confidence: detectConfidence(result),
  };
}

/**
 * Consolidate conversation history into a MEMORY.md knowledge file.
 *
 * Scans conversation search results for key topics and produces
 * a structured markdown file grouping memories by category.
 */
export async function consolidateMemories(
  projectPath?: string,
  options?: {
    output_path?: string;
    max_sessions?: number;
    min_confidence?: Memory["confidence"];
  },
): Promise<ConsolidationResult> {
  const start = performance.now();

  // Resolve project path
  const cwd = projectPath ?? process.cwd();
  const convPath = getClaudeConversationProjectPath(cwd);
  const projectName = basename(convPath);

  // Search for key knowledge-bearing topics
  const KNOWLEDGE_QUERIES = [
    "architecture decision design",
    "bug fix error solution",
    "pattern convention standard",
    "configuration setup install",
    "important gotcha caveat",
    "preference style choice",
    "refactoring improvement",
    "performance optimization",
    "testing strategy approach",
    "deployment pipeline CI",
  ];

  const allResults: ConversationSearchResult[] = [];
  const seenSessions = new Set<string>();

  for (const query of KNOWLEDGE_QUERIES) {
    try {
      const searchResult = await searchConversations(query, cwd, options?.max_sessions ?? 10);
      for (const r of searchResult.results) {
        const key = `${r.session_id}:${r.turn_index}`;
        if (!seenSessions.has(key)) {
          seenSessions.add(key);
          allResults.push(r);
        }
      }
    } catch {
      // Skip failed searches — non-fatal
    }
  }

  // Extract memories from results
  const minConfidence = options?.min_confidence ?? "low";
  const confidenceOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const minLevel = confidenceOrder[minConfidence] ?? 1;

  const memories: Memory[] = [];
  for (const result of allResults) {
    const memory = extractMemoryFromResult(result);
    if (memory && (confidenceOrder[memory.confidence] ?? 0) >= minLevel) {
      memories.push(memory);
    }
  }

  // Deduplicate by summary similarity (simple)
  const unique: Memory[] = [];
  const seenSummaries = new Set<string>();
  for (const m of memories) {
    const key = m.summary.toLowerCase().slice(0, 60);
    if (!seenSummaries.has(key)) {
      seenSummaries.add(key);
      unique.push(m);
    }
  }

  // Group by category
  const grouped = new Map<string, Memory[]>();
  for (const m of unique) {
    const list = grouped.get(m.category) ?? [];
    list.push(m);
    grouped.set(m.category, list);
  }

  // Generate MEMORY.md
  const categoryLabels: Record<string, string> = {
    decision: "Decisions",
    solution: "Solutions & Bug Fixes",
    pattern: "Patterns & Conventions",
    architecture: "Architecture",
    gotcha: "Gotchas & Caveats",
    preference: "Preferences & Style",
  };

  const sections: string[] = [];
  sections.push("# Project Memory");
  sections.push("");
  sections.push(`> Auto-consolidated from ${allResults.length} conversation turns on ${new Date().toISOString().split("T")[0]}`);
  sections.push(`> Project: ${projectName}`);
  sections.push("");

  const categoryCounts: Record<string, number> = {};

  for (const [category, items] of grouped) {
    const label = categoryLabels[category] ?? category;
    categoryCounts[category] = items.length;

    sections.push(`## ${label}`);
    sections.push("");

    // Sort by confidence (high first), then by timestamp
    items.sort((a, b) => {
      const confDiff = (confidenceOrder[b.confidence] ?? 0) - (confidenceOrder[a.confidence] ?? 0);
      return confDiff !== 0 ? confDiff : b.timestamp.localeCompare(a.timestamp);
    });

    for (const m of items.slice(0, 20)) {
      const confBadge = m.confidence === "high" ? "" : m.confidence === "medium" ? " (?)" : " (?)";
      sections.push(`### ${m.summary}${confBadge}`);
      if (m.timestamp) {
        sections.push(`_${m.timestamp}_`);
      }
      sections.push("");
      sections.push(m.detail);
      sections.push("");
    }
  }

  const outputPath = options?.output_path ?? join(cwd, "MEMORY.md");
  await writeFile(outputPath, sections.join("\n"), "utf-8");

  return {
    project: projectName,
    sessions_analyzed: allResults.length,
    memories_extracted: unique.length,
    output_path: outputPath,
    categories: categoryCounts,
    elapsed_ms: Math.round(performance.now() - start),
  };
}

/**
 * Read an existing MEMORY.md and return its contents.
 */
export async function readMemory(
  projectPath?: string,
): Promise<{ content: string; path: string } | null> {
  const memoryPath = join(projectPath ?? process.cwd(), "MEMORY.md");
  try {
    const content = await readFile(memoryPath, "utf-8");
    return { content, path: memoryPath };
  } catch {
    return null;
  }
}
