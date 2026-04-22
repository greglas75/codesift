#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

export interface CitationResult {
  total: number;
  grounded: number;
  percentage: number;
  ungrounded: Array<{ literal: string; kind: "sha" | "date" | "version" }>;
}

export async function runCitationCheck(
  phaseFile: string,
  threshold: number,
): Promise<CitationResult> {
  const content = await readFile(phaseFile, "utf-8");
  const literals = extractLiterals(content);
  const groundedLits = literals.filter((lit) => isGrounded(lit));
  const percentage =
    literals.length === 0 ? 100 : (groundedLits.length / literals.length) * 100;
  const ungrounded = literals.filter((lit) => !isGrounded(lit));
  return {
    total: literals.length,
    grounded: groundedLits.length,
    percentage,
    ungrounded,
  };
}

export function extractLiterals(
  content: string,
): Array<{ literal: string; kind: "sha" | "date" | "version" }> {
  const result: Array<{ literal: string; kind: "sha" | "date" | "version" }> =
    [];
  // SHAs: hex runs 7-40 chars (standalone words)
  for (const m of content.matchAll(/\b([a-f0-9]{7,40})\b/g)) {
    result.push({ literal: m[1]!, kind: "sha" });
  }
  // Dates: YYYY-MM-DD
  for (const m of content.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
    result.push({ literal: m[1]!, kind: "date" });
  }
  // Versions inside backticks: `vX.Y.Z`
  for (const m of content.matchAll(/`(v\d+\.\d+\.\d+)`/g)) {
    result.push({ literal: m[1]!, kind: "version" });
  }
  return result;
}

// Cache to avoid repeated git calls per literal
let shaCache: Set<string> | null = null;
let dateCache: Set<string> | null = null;
let versionCache: Set<string> | null = null;

function loadShaCache(): Set<string> {
  if (shaCache) return shaCache;
  const out = execFileSync("git", ["log", "--all", "--format=%H"], {
    encoding: "utf-8",
  });
  const s = new Set<string>();
  for (const line of out.split("\n")) {
    const sha = line.trim();
    if (!sha) continue;
    // add all prefix lengths >= 7 so short SHAs resolve
    for (let len = 7; len <= sha.length; len++) s.add(sha.slice(0, len));
    s.add(sha);
  }
  return (shaCache = s);
}

function loadDateCache(): Set<string> {
  if (dateCache) return dateCache;
  const out = execFileSync(
    "git",
    ["log", "--all", "--format=%ad", "--date=short"],
    { encoding: "utf-8" },
  );
  const s = new Set<string>();
  for (const line of out.split("\n")) {
    const d = line.trim();
    if (d) s.add(d);
  }
  return (dateCache = s);
}

function loadVersionCache(): Set<string> {
  if (versionCache) return versionCache;
  let out = "";
  try {
    out = execFileSync("git", ["tag", "-l"], { encoding: "utf-8" });
  } catch {
    // no tags — treat as empty set (CQ8)
  }
  const s = new Set<string>();
  for (const line of out.split("\n")) {
    const v = line.trim();
    if (v) s.add(v);
  }
  return (versionCache = s);
}

function isGrounded(lit: {
  literal: string;
  kind: "sha" | "date" | "version";
}): boolean {
  if (lit.kind === "sha") return loadShaCache().has(lit.literal);
  if (lit.kind === "date") return loadDateCache().has(lit.literal);
  if (lit.kind === "version") return loadVersionCache().has(lit.literal);
  return false;
}

// CLI entry — only when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  const thresholdIdx = process.argv.indexOf("--threshold");
  const threshold =
    thresholdIdx >= 0 ? Number(process.argv[thresholdIdx + 1]) : 95;
  if (!file) {
    console.error(
      "Usage: journal-citation-check <file> [--threshold N]",
    );
    process.exit(2);
  }
  runCitationCheck(file, threshold).then((res) => {
    console.log(
      `Grounded: ${res.grounded}/${res.total} (${res.percentage.toFixed(1)}%)`,
    );
    for (const u of res.ungrounded) {
      console.log(`  ungrounded: ${u.kind}:${u.literal}`);
    }
    process.exit(res.percentage >= threshold ? 0 : 1);
  });
}
