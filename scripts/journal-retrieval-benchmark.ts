#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BenchmarkQuery {
  query: string;
  expected_phase_slug: string;
  expected_commit_shas: string[];
  forbidden_claims: string[];
}

export interface BenchmarkPlan {
  model: string;
  dry_run: boolean;
  query_count: number;
  queries: Array<{
    index: number;
    expected_phase_slug: string;
    query: string;
  }>;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

const YAML_PATH_DEFAULT = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../benchmarks/journal-queries.yaml",
);

export async function loadQueries(path: string): Promise<BenchmarkQuery[]> {
  const raw = await readFile(path, "utf-8");
  try {
    const yaml = await import("yaml");
    return yaml.parse(raw) as BenchmarkQuery[];
  } catch {
    return parseQueriesInline(raw);
  }
}

/**
 * Minimal inline YAML parser for the list-of-maps shape used in journal-queries.yaml.
 * Handles top-level list items (- key: value) and sequence values (- item).
 * This is a fallback for environments where the `yaml` package is unavailable.
 */
export function parseQueriesInline(raw: string): BenchmarkQuery[] {
  const entries: BenchmarkQuery[] = [];
  let current: Partial<BenchmarkQuery> | null = null;
  let inArrayField: "expected_commit_shas" | "forbidden_claims" | null = null;

  for (const line of raw.split("\n")) {
    const topItem = /^- (\w+): (.+)$/.exec(line);
    if (topItem) {
      if (current) entries.push(current as BenchmarkQuery);
      const [, key, value] = topItem;
      current = { expected_commit_shas: [], forbidden_claims: [] };
      inArrayField = null;
      applyScalar(current, key!, value!.trim());
      continue;
    }

    const arrayField = /^  (\w+):$/.exec(line);
    if (arrayField && current) {
      const fieldName = arrayField[1]!;
      if (fieldName === "expected_commit_shas" || fieldName === "forbidden_claims") {
        inArrayField = fieldName;
      } else {
        inArrayField = null;
      }
      continue;
    }

    const scalarField = /^  (\w+): (.+)$/.exec(line);
    if (scalarField && current) {
      inArrayField = null;
      const [, key, value] = scalarField;
      applyScalar(current, key!, value!.trim());
      continue;
    }

    const arrayItem = /^    - (.+)$/.exec(line);
    if (arrayItem && current && inArrayField) {
      const val = arrayItem[1]!.replace(/^["']|["']$/g, "");
      (current[inArrayField] as string[]).push(val);
    }
  }

  if (current) entries.push(current as BenchmarkQuery);
  return entries;
}

function applyScalar(obj: Partial<BenchmarkQuery>, key: string, value: string): void {
  if (key === "query") obj.query = value.replace(/^["']|["']$/g, "");
  else if (key === "expected_phase_slug") obj.expected_phase_slug = value.replace(/^["']|["']$/g, "");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const model = process.env["CLAUDE_BENCH_MODEL"] ?? DEFAULT_MODEL;
  const queries = await loadQueries(YAML_PATH_DEFAULT);

  console.log(`${queries.length} queries loaded`);
  console.log(`Model: ${model}`);

  if (dryRun) {
    const plan: BenchmarkPlan = {
      model,
      dry_run: true,
      query_count: queries.length,
      queries: queries.map((q, i) => ({
        index: i,
        expected_phase_slug: q.expected_phase_slug,
        query: q.query,
      })),
    };

    for (const q of plan.queries) {
      console.log(`  - [${q.expected_phase_slug}] ${q.query}`);
    }

    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    process.exit(0);
  }

  console.log("live mode not yet wired; use --dry-run for now");
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
