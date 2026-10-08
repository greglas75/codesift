#!/usr/bin/env node
/**
 * How badly does a full index starve the process that serves tool calls?
 *
 * Reproduces the 2026-10-08 sessions-host incident in miniature: the shared daemon indexed (and
 * embedded) a fresh worktree on its request-serving thread, `/health` sat at `busy` with
 * `event_loop_lag_ms` ≈ 2,200 for minutes, and `search_symbols` timed out at 90 s. This indexes a
 * generated TypeScript tree while a probe issues a cheap call every 50 ms, and reports what the
 * probe saw — the latency an agent's `index_status` would have had — plus the loop's lateness
 * sampled every 10 ms.
 *
 *   npm run build
 *   node scripts/bench-index-event-loop.mjs [--files 4000] [--modes inproc,child] [--embed]
 *
 * `--embed` starts a stub Ollama in its OWN process (zero vectors, answers instantly), so the
 * embedding phase's main-thread cost is measured without a real model — and without the stub's
 * own responses being delayed by the very loop being measured.
 *
 * Each mode runs in a fresh process with a fresh data dir, so no cache from one leaks into the next.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "dist");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function generateFixture(root, files) {
  // ~36 symbols per file (30 functions, a class with 5 methods), bodies long enough that parse and
  // chunk text are not trivially small. Deterministic, so two modes index identical content.
  for (let f = 0; f < files; f++) {
    const dir = join(root, "src", `pkg${f % 40}`, `mod${Math.floor(f / 40) % 25}`);
    mkdirSync(dir, { recursive: true });
    const lines = [];
    const prev = f > 0 ? `../../pkg${(f - 1) % 40}/mod${Math.floor((f - 1) / 40) % 25}/file${f - 1}` : null;
    if (prev) lines.push(`import { fn${f - 1}_0 } from "${prev}";`);
    for (let s = 0; s < 30; s++) {
      lines.push(
        `export function fn${f}_${s}(input: number, label: string): { value: number; label: string } {`,
        `  const scaled = input * ${s + 1} + ${f};`,
        `  if (scaled % 3 === 0) {`,
        `    return { value: scaled / 3, label: label + "-third" };`,
        `  }`,
        `  for (let i = 0; i < ${(s % 5) + 1}; i++) {`,
        `    if (i === ${s % 3}) continue;`,
        `  }`,
        `  return { value: scaled, label };`,
        `}`,
        "",
      );
    }
    lines.push(`export class Service${f} {`, `  private readonly cache = new Map<string, number>();`);
    for (let m = 0; m < 5; m++) {
      lines.push(
        `  method${m}(key: string): number {`,
        `    const hit = this.cache.get(key);`,
        `    if (hit !== undefined) return hit;`,
        `    const computed = key.length * ${m + 2};`,
        `    this.cache.set(key, computed);`,
        `    return computed;`,
        `  }`,
      );
    }
    lines.push("}", "");
    writeFileSync(join(dir, `file${f}.ts`), lines.join("\n"));
  }
}

// ---------------------------------------------------------------------------
// Stub embedding server (separate process)
// ---------------------------------------------------------------------------

const STUB_SOURCE = `
const http = require("node:http");
const dims = 768;
const zero = new Array(dims).fill(0.001);
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let n = 0;
    try { n = JSON.parse(body).input.length; } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ embeddings: Array.from({ length: n }, () => zero) }));
  });
});
server.listen(0, "127.0.0.1", () => { process.stdout.write(String(server.address().port) + "\\n"); });
`;

function startStub() {
  return new Promise((resolveStub, reject) => {
    const child = spawn(process.execPath, ["-e", STUB_SOURCE], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.once("data", (buf) => resolveStub({ port: Number(String(buf).trim()), child }));
    child.once("error", reject);
  });
}

// ---------------------------------------------------------------------------
// One measured run (in its own process)
// ---------------------------------------------------------------------------

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarise(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: Math.round(pct(sorted, 50)),
    p99: Math.round(pct(sorted, 99)),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
  };
}

async function runOne() {
  const fixture = arg("fixture");
  const probeRoot = arg("probe-root");
  const mod = (p) => import(pathToFileURL(join(DIST, p)).href);
  const tools = await mod("tools/index-tools.js");
  const { awaitPendingEmbeddings } = await mod("tools/index-tools/folder-indexer.js");
  const { loadIndexSummary, getIndexPath } = await mod("storage/index-store.js");
  const { loadConfig } = await mod("config.js");

  // A small repo indexed BEFORE measuring: the probe answers `getIndexSummary` from it, i.e. what an
  // `index_status` call costs — a light call that should be instant on an idle loop.
  const probe = await tools.indexFolder(probeRoot, { watch: false });
  await awaitPendingEmbeddings();

  const lags = [];
  let expected = Date.now() + 10;
  const sampler = setInterval(() => {
    const now = Date.now();
    lags.push(Math.max(0, now - expected));
    expected = now + 10;
  }, 10);

  const probeLatencies = [];
  let probing = true;
  const prober = (async () => {
    while (probing) {
      const t0 = performance.now();
      await tools.getIndexSummary(probe.repo, { skipFreshness: true });
      probeLatencies.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();

  const t0 = performance.now();
  const result = await tools.indexFolder(fixture, { watch: false });
  const indexMs = performance.now() - t0;
  const lagsAtIndex = lags.length;
  const probesAtIndex = probeLatencies.length;
  await awaitPendingEmbeddings();
  const totalMs = performance.now() - t0;

  probing = false;
  await prober;
  clearInterval(sampler);

  const summary = await loadIndexSummary(getIndexPath(loadConfig().dataDir, result.root));
  const blockedMs = lags.filter((l) => l >= 100).reduce((a, b) => a + b, 0);
  return {
    mode: process.env.CODESIFT_INDEX_OUT_OF_PROCESS === "1" ? "child" : "inproc",
    files: summary?.file_count ?? null,
    symbols: summary?.symbol_count ?? null,
    index_ms: Math.round(indexMs),
    total_ms: Math.round(totalMs),
    loop_lag_ms_index_phase: summarise(lags.slice(0, lagsAtIndex)),
    loop_lag_ms_overall: summarise(lags),
    loop_blocked_ms_ge100: Math.round(blockedMs),
    probe_ms_index_phase: summarise(probeLatencies.slice(0, probesAtIndex)),
    probe_ms_overall: summarise(probeLatencies),
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function main() {
  if (arg("run-one")) {
    const out = await runOne();
    process.stdout.write(`__bench__${JSON.stringify(out)}\n`);
    process.exit(0);
  }

  const files = Number(arg("files", "4000"));
  const modes = String(arg("modes", "inproc,child")).split(",");
  const embed = arg("embed", false) === true;

  const scratch = mkdtempSync(join(tmpdir(), "codesift-bench-"));
  const fixture = join(scratch, "fixture");
  const probeRoot = join(scratch, "probe");
  generateFixture(fixture, files);
  generateFixture(probeRoot, 20);
  // A git checkout, so HEAD capture and freshness behave as on a real repo.
  for (const dir of [fixture, probeRoot]) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=b@b", "-c", "user.name=b", "commit", "-qm", "fixture"], { cwd: dir });
  }

  const stub = embed ? await startStub() : null;
  const results = [];
  try {
    for (const mode of modes) {
      const dataDir = join(scratch, `data-${mode}`);
      const env = {
        ...process.env,
        CODESIFT_DATA_DIR: dataDir,
        CODESIFT_INDEX_OUT_OF_PROCESS: mode === "child" ? "1" : "0",
        CODESIFT_WATCH: "0",
        CODESIFT_AUTO_PRUNE: "0",
        CODESIFT_TELEMETRY: "0",
      };
      delete env.CODESIFT_EMBED_OUT_OF_PROCESS;
      if (stub) {
        env.CODESIFT_EMBEDDING_PROVIDER = "ollama";
        env.CODESIFT_OLLAMA_URL = `http://127.0.0.1:${stub.port}`;
        env.CODESIFT_OLLAMA_DIMENSIONS = "768";
        env.CODESIFT_OLLAMA_MODEL = "stub";
      } else {
        delete env.CODESIFT_EMBEDDING_PROVIDER;
        delete env.CODESIFT_OLLAMA_URL;
        env.CODESIFT_DISABLE_LOCAL_EMBEDDINGS = "1";
      }
      const out = await new Promise((resolveRun, reject) => {
        const child = spawn(
          process.execPath,
          [...process.execArgv, fileURLToPath(import.meta.url), "--run-one", "--fixture", fixture, "--probe-root", probeRoot],
          { env, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderrTail = "";
        child.stdout.on("data", (b) => { stdout += b; });
        child.stderr.on("data", (b) => { stderrTail = (stderrTail + b).slice(-4000); });
        child.on("close", (code) => {
          const line = stdout.split("\n").find((l) => l.startsWith("__bench__"));
          if (!line) reject(new Error(`run ${mode} failed (exit ${code}):\n${stderrTail}`));
          else resolveRun(JSON.parse(line.slice("__bench__".length)));
        });
      });
      results.push({ embed, ...out });
      console.log(JSON.stringify({ embed, ...out }));
    }
  } finally {
    stub?.child.kill();
    if (!arg("keep")) rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
