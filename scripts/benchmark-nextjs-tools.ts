#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * SC3: nextjsRouteMap must complete in <5000ms on 500 synthetic route files.
 * SC4: analyze_nextjs_components must complete in <3000ms on 200 synthetic
 *      component files.
 *
 * Both benchmarks run against tmpdir fixtures and exit non-zero if any
 * deadline is missed.
 */

import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkDirectory } from "../src/utils/walk.js";
import { scanDirective } from "../src/utils/nextjs.js";
import { parseFile } from "../src/parser/parser-manager.js";
import {
  confirmDirectiveFromTree,
  detectSignals,
  applyClassificationTable,
} from "../src/tools/nextjs-component-tools.js";
import { parseRouteFile } from "../src/tools/nextjs-route-tools.js";

const SC3_BUDGET_MS = 5000;
const SC4_BUDGET_MS = 3000;
const FILE_COUNT = 200;
const ROUTE_COUNT = 500;

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

async function generateRouteFixture(root: string): Promise<void> {
  const appDir = join(root, "app");
  await mkdir(appDir, { recursive: true });
  // Root layout + root page
  await writeFile(
    join(appDir, "layout.tsx"),
    `export default function L({ children }: any) { return children; }\n`,
  );
  for (let i = 0; i < ROUTE_COUNT; i++) {
    const dir = join(appDir, `p${i}`);
    await mkdir(dir, { recursive: true });
    // Mix: 70% static pages, 15% ISR, 10% SSR, 5% route.ts
    const mod = i % 20;
    if (mod < 14) {
      await writeFile(join(dir, "page.tsx"), `export default function P${i}() { return <div>${i}</div>; }\n`);
    } else if (mod < 17) {
      await writeFile(
        join(dir, "page.tsx"),
        `export const revalidate = 60;\nexport default function P${i}() { return <div>${i}</div>; }\n`,
      );
    } else if (mod < 19) {
      await writeFile(
        join(dir, "page.tsx"),
        `export const dynamic = "force-dynamic";\nexport default function P${i}() { return <div>${i}</div>; }\n`,
      );
    } else {
      await writeFile(
        join(dir, "route.ts"),
        `export async function GET() { return new Response("${i}"); }\n`,
      );
    }
  }
}

async function runRouteMap(root: string): Promise<number> {
  // Mirror nextjsRouteMap's flow without going through getCodeIndex
  const walked = await walkDirectory(join(root, "app"), {
    followSymlinks: true,
    fileFilter: (ext, name) => {
      if (![".tsx", ".jsx", ".ts", ".js"].includes(ext)) return false;
      if (!name) return false;
      return /^(page|route|layout|loading|error|not-found|default|template|global-error)\.[jt]sx?$/.test(name);
    },
  });

  let count = 0;
  const BATCH = 10;
  for (let i = 0; i < walked.length; i += BATCH) {
    const chunk = walked.slice(i, i + BATCH);
    await Promise.all(
      chunk.map(async (abs) => {
        await parseRouteFile(abs, root, "app");
        count++;
      }),
    );
  }
  return count;
}

async function runSC4(): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "nextjs-bench-c-"));
  try {
    await generateFixture(root);
    await parseFile(join(root, "app", "segment0", "page.tsx"), "const x=1;\n");

    const t0 = performance.now();
    const classified = await runClassifier(root);
    const elapsed = performance.now() - t0;

    if (classified < FILE_COUNT) {
      console.error(`FAIL: classified only ${classified}/${FILE_COUNT} files`);
      return false;
    }
    if (elapsed > SC4_BUDGET_MS) {
      console.error(
        `FAIL: SC4 deadline missed — elapsed=${elapsed.toFixed(0)}ms (budget=${SC4_BUDGET_MS}ms)`,
      );
      return false;
    }
    console.log(`SC4: PASS elapsed=${elapsed.toFixed(0)}ms (${classified}/${FILE_COUNT} files, budget=${SC4_BUDGET_MS}ms)`);
    return true;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function runSC3(): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "nextjs-bench-r-"));
  try {
    await generateRouteFixture(root);
    // Warm the tsx grammar cache
    await parseFile(join(root, "app", "layout.tsx"), "const x=1;\n");

    const t0 = performance.now();
    const processed = await runRouteMap(root);
    const elapsed = performance.now() - t0;

    if (processed < ROUTE_COUNT) {
      console.error(`FAIL: processed only ${processed}/${ROUTE_COUNT} routes`);
      return false;
    }
    if (elapsed > SC3_BUDGET_MS) {
      console.error(
        `FAIL: SC3 deadline missed — elapsed=${elapsed.toFixed(0)}ms (budget=${SC3_BUDGET_MS}ms)`,
      );
      return false;
    }
    console.log(`SC3: PASS elapsed=${elapsed.toFixed(0)}ms (${processed}/${ROUTE_COUNT} routes, budget=${SC3_BUDGET_MS}ms)`);
    return true;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function run(): Promise<number> {
  const ok4 = await runSC4();
  const ok3 = await runSC3();
  return ok4 && ok3 ? 0 : 1;
}

process.exit(await run());
