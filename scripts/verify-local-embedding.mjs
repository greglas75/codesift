#!/usr/bin/env node
// One-shot smoke for the local embedding provider, runnable outside vitest.
// vitest's VM context crashes onnxruntime-node on Float32Array prototype checks,
// so we exercise the real path through plain `node`.
//
// Usage:
//   node scripts/verify-local-embedding.mjs
//   CODESIFT_LOCAL_MODEL=Xenova/bge-small-en-v1.5 node scripts/verify-local-embedding.mjs

import { LocalProvider, getPrefix } from "../dist/search/semantic.js";

const model = process.env.CODESIFT_LOCAL_MODEL ?? "nomic-ai/nomic-embed-text-v1.5";
const provider = new LocalProvider(model);

console.log(`[verify] model:      ${provider.model}`);
console.log(`[verify] dimensions: ${provider.dimensions}`);
console.log(`[verify] doc prefix: ${JSON.stringify(getPrefix(provider.model, "document"))}`);
console.log(`[verify] qry prefix: ${JSON.stringify(getPrefix(provider.model, "query"))}`);

const docs = await provider.embed(["authentication helper", "user lookup function"], "document");
if (docs.length !== 2 || docs[0].length !== provider.dimensions) {
  console.error(`[verify] FAIL: expected 2 vectors of ${provider.dimensions}d; got ${docs.length} of ${docs[0]?.length}d`);
  process.exit(1);
}

// Self-similarity of a normalized vector should be ~1.
const dot = docs[0].reduce((acc, v) => acc + v * v, 0);
if (Math.abs(dot - 1) > 1e-3) {
  console.error(`[verify] FAIL: vector not normalized (||v||² = ${dot.toFixed(6)}, expected ≈ 1)`);
  process.exit(1);
}

const [q] = await provider.embed(["authentication"], "query");
const [d] = await provider.embed(["authentication"], "document");
const queryVsDoc = q.reduce((acc, v, i) => acc + v * d[i], 0);
console.log(`[verify] same-text query↔doc cosine: ${queryVsDoc.toFixed(4)} (lower = prefixes are working)`);

console.log("[verify] OK");
