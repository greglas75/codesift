#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * SC4: analyze_nextjs_components must complete in <3000ms on 200 synthetic
 * component files. Creates a tmpdir fixture and runs the full classifier
 * pipeline (walk → parse → signals → classification) against it.
 *
 * Exit 0 on PASS, 1 if the wall-clock deadline is missed.
 *
 * Task 33 extends this script with an SC3 route-map benchmark.
 */

import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { walkDirectory } from "../src/utils/walk.js";
import { scanDirective } from "../src/utils/nextjs.js";
import { parseFile } from "../src/parser/parser-manager.js";
import {
  confirmDirectiveFromTree,
  detectSignals,
  applyClassificationTable,
} from "../src/tools/nextjs-component-tools.js";

const SC4_BUDGET_MS = 3000;
const FILE_COUNT = 200;

async function generateFixture(root: string): Promise<void> {
  const appDir = join(root, "app");
  await mkdir(appDir, { recursive: true });
  for (let i = 0; i < FILE_COUNT; i++) {
    const dir = join(appDir, `segment${i}`);
    await mkdir(dir, { recursive: true });
    // Mix of server (70%), client_inferred (20%), client_explicit (10%).
    let content: string;
    const mod = i % 10;
    if (mod < 7) {
      content = `export default function S${i}() { return <div>server ${i}</div>; }\n`;
    } else if (mod < 9) {
      content = `import { useState } from "react";\nexport default function C${i}() { const [x, setX] = useState(${i}); return <button onClick={() => setX(x+1)}>{x}</button>; }\n`;
    } else {
      content = `"use client";\nimport { useEffect } from "react";\nexport default function E${i}() { useEffect(() => {}, []); return <div>${i}</div>; }\n`;
    }
    await writeFile(join(dir, "page.tsx"), content);
  }
}

async function runClassifier(root: string): Promise<number> {
  const walked = await walkDirectory(join(root, "app"), {
    followSymlinks: true,
    fileFilter: (ext) => ext === ".tsx" || ext === ".jsx",
  });

  let count = 0;
  const BATCH = 10;
  for (let i = 0; i < walked.length; i += BATCH) {
    const chunk = walked.slice(i, i + BATCH);
    await Promise.all(
      chunk.map(async (abs) => {
        const source = await readFile(abs, "utf8");
        const tree = await parseFile(abs, source);
        if (!tree) return;
        const d1 = await scanDirective(abs);
        const directive = d1 !== null ? confirmDirectiveFromTree(tree) : null;
        const signals = detectSignals(tree, source);
        applyClassificationTable(directive, signals);
        count++;
      }),
    );
  }
  return count;
}

async function run(): Promise<number> {
  const root = await mkdtemp(join(tmpdir(), "nextjs-bench-"));
  try {
    await generateFixture(root);
    // Warm the tsx grammar cache once so we measure steady-state cost.
    await parseFile(join(root, "app", "segment0", "page.tsx"), "const x=1;\n");

    const t0 = performance.now();
    const classified = await runClassifier(root);
    const elapsed = performance.now() - t0;

    if (classified < FILE_COUNT) {
      console.error(
        `FAIL: classified only ${classified}/${FILE_COUNT} files`,
      );
      return 1;
    }
    if (elapsed > SC4_BUDGET_MS) {
      console.error(
        `FAIL: SC4 deadline missed — elapsed=${elapsed.toFixed(0)}ms (budget=${SC4_BUDGET_MS}ms)`,
      );
      return 1;
    }

    console.log(`SC4: PASS elapsed=${elapsed.toFixed(0)}ms (${classified}/${FILE_COUNT} files, budget=${SC4_BUDGET_MS}ms)`);
    return 0;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

process.exit(await run());
