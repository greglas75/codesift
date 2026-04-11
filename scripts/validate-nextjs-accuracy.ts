#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * SC1: Validate analyze_nextjs_components accuracy against the frozen
 * `tests/fixtures/nextjs-app-router/expected.json` ground truth.
 *
 * Assertions:
 *   - parse_failures.length === 0 (fixture invariant)
 *   - directive detection recall === 1.0 (every file with a directive is detected)
 *   - unnecessary_use_client precision >= 0.95
 *   - per-file classification matches expected.json exactly
 *
 * Exit 0 on PASS, 1 on FAIL.
 */

import { readFile } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { walkDirectory } from "../src/utils/walk.js";
import { scanDirective } from "../src/utils/nextjs.js";
import { parseFile } from "../src/parser/parser-manager.js";
import {
  confirmDirectiveFromTree,
  detectSignals,
  applyClassificationTable,
  type NextjsComponentEntry,
} from "../src/tools/nextjs-component-tools.js";

interface ExpectedEntry {
  classification: string;
  directive: string | null;
  violations: string[];
}

interface Expected {
  counts: Record<string, number>;
  files: Record<string, ExpectedEntry>;
}

const fixtureRoot = resolve(import.meta.dirname, "../tests/fixtures/nextjs-app-router");
const expectedPath = join(fixtureRoot, "expected.json");

async function run(): Promise<number> {
  const expected: Expected = JSON.parse(await readFile(expectedPath, "utf8"));

  // Mirror analyzeNextjsComponents file walk (without going through getCodeIndex)
  const files: NextjsComponentEntry[] = [];
  const parse_failures: string[] = [];

  const walked = await walkDirectory(join(fixtureRoot, "app"), {
    followSymlinks: true,
    fileFilter: (ext) => ext === ".tsx" || ext === ".jsx",
  });

  for (const abs of walked) {
    const rel = relative(fixtureRoot, abs);
    const source = await readFile(abs, "utf8");
    const tree = await parseFile(abs, source);
    if (!tree) {
      parse_failures.push(rel);
      continue;
    }
    const d1 = await scanDirective(abs);
    const directive = d1 !== null ? confirmDirectiveFromTree(tree) : null;
    const signals = detectSignals(tree, source);
    const { classification, violations } = applyClassificationTable(directive, signals);
    files.push({
      path: rel,
      classification,
      directive,
      signals,
      violations,
    });
  }

  // Assertion 1: fixture invariant
  if (parse_failures.length !== 0) {
    console.error(`FAIL: parse_failures is not empty: ${parse_failures.join(", ")}`);
    return 1;
  }

  // Assertion 2: per-file comparison
  const mismatches: string[] = [];
  let directiveHits = 0;
  let directiveTotal = 0;
  let unnecessaryCorrect = 0;
  let unnecessaryFlagged = 0;

  for (const entry of files) {
    const exp = expected.files[entry.path];
    if (!exp) {
      mismatches.push(`${entry.path}: missing from expected.json`);
      continue;
    }
    if (exp.classification !== entry.classification) {
      mismatches.push(
        `${entry.path}: classification mismatch (expected=${exp.classification}, actual=${entry.classification})`,
      );
    }
    if (exp.directive !== entry.directive) {
      mismatches.push(
        `${entry.path}: directive mismatch (expected=${exp.directive}, actual=${entry.directive})`,
      );
    }
    const expViol = JSON.stringify([...exp.violations].sort());
    const actViol = JSON.stringify([...entry.violations].sort());
    if (expViol !== actViol) {
      mismatches.push(
        `${entry.path}: violations mismatch (expected=${expViol}, actual=${actViol})`,
      );
    }

    if (exp.directive !== null) {
      directiveTotal++;
      if (entry.directive === exp.directive) directiveHits++;
    }
    if (entry.violations.includes("unnecessary_use_client")) {
      unnecessaryFlagged++;
      if (exp.violations.includes("unnecessary_use_client")) unnecessaryCorrect++;
    }
  }

  if (mismatches.length > 0) {
    console.error("FAIL: classification mismatches:");
    for (const m of mismatches) console.error(`  ${m}`);
    return 1;
  }

  const recall = directiveTotal === 0 ? 1 : directiveHits / directiveTotal;
  const precision = unnecessaryFlagged === 0 ? 1 : unnecessaryCorrect / unnecessaryFlagged;

  if (recall < 1.0) {
    console.error(`FAIL: directive recall ${recall.toFixed(3)} < 1.0`);
    return 1;
  }
  if (precision < 0.95) {
    console.error(`FAIL: unnecessary_use_client precision ${precision.toFixed(3)} < 0.95`);
    return 1;
  }

  console.log(
    `SC1: PASS precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} (files=${files.length})`,
  );
  return 0;
}

process.exit(await run());
