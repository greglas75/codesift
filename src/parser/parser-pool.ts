/**
 * Worker pool for tree-sitter parsing — see parse-worker.ts for rationale.
 *
 * Maintains a fixed number of long-lived workers (default 2). Each parse
 * request is dispatched to the worker with the lowest active task count.
 * Per-task timeout protects against hung parses; on timeout we terminate
 * the worker (since WASM may be stuck synchronously) and respawn. Worker
 * exits (crashes) are caught and respawned the same way.
 *
 * Pool is lazy-initialized on first parse and persists across index_folder
 * calls — workers warm up parser caches over time.
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import type { CodeSymbol } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Decide whether the worker pool can be used in this runtime.
 *
 * Production (dist/parser/): `parse-worker.js` exists next to this module —
 * spawn workers as designed for full crash isolation.
 *
 * Dev / vitest (src/parser/): only `parse-worker.ts` exists. Worker threads
 * cannot natively load .ts in Node 22 and tsx's loader auto-register is
 * gated on `isMainThread`, so spawning a worker from .ts requires a
 * bootstrap shim. To keep the dev/test surface simple we instead fall back
 * to in-thread parsing — the worker pool exists for crash isolation in the
 * production MCP server, not for tests (a hung WASM parse in vitest just
 * means restart vitest).
 *
 * Override:
 *   CODESIFT_PARSER_INLINE=1   force in-thread (skip pool even if .js exists)
 */
function isPoolAvailable(): boolean {
  if (process.env.CODESIFT_PARSER_INLINE === "1") return false;
  return existsSync(resolve(__dirname, "parse-worker.js"));
}

interface PendingTask {
  resolve: (symbols: CodeSymbol[]) => void;
  reject: (err: Error) => void;
  timeoutHandle: NodeJS.Timeout;
  filePath: string;
}

interface PoolWorker {
  worker: Worker;
  pendingTasks: Map<number, PendingTask>;
  activeCount: number;
}

const DEFAULT_POOL_SIZE = 2;
const DEFAULT_TASK_TIMEOUT_MS = 60_000;

let pool: PoolWorker[] = [];
let nextTaskId = 1;
let initialized = false;
// Set while shutdownPool() is tearing the pool down. terminate() makes a worker
// exit with code 1, which the exit handler would otherwise treat as a crash and
// respawn — spawning a fresh worker mid-shutdown that nothing then closes, so
// its MessagePort keeps the event loop alive and `codesift index` hangs ~10s
// until the backstop timer fires. The flag suppresses that respawn.
let shuttingDown = false;

function getPoolSize(): number {
  const env = process.env.CODESIFT_PARSER_POOL_SIZE;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_POOL_SIZE;
}

function getTaskTimeoutMs(): number {
  const env = process.env.CODESIFT_PARSER_TASK_TIMEOUT_MS;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TASK_TIMEOUT_MS;
}

function spawnWorker(): PoolWorker {
  const workerPath = resolve(__dirname, "parse-worker.js");
  const worker = new Worker(workerPath);

  // Do not let a pool worker hold the event loop open.
  //
  // These threads live for the whole process, so a one-shot `codesift index`
  // could never exit on its own — process._getActiveHandles() still showed
  // their MessagePorts after the command was done, and terminate() did not
  // release them promptly. That forced a hard exit, and forcing an exit with an
  // onnxruntime session loaded aborts in native teardown (`libc++abi ... mutex
  // lock failed`, exit 134) — which is why indexing "failed" while having
  // written every file correctly.
  //
  // unref() only removes the thread from the loop's liveness count; it keeps
  // running and still delivers messages. Each in-flight parse is awaited by its
  // caller, and those awaits are what keep the process alive while work remains.
  worker.unref();
  const pw: PoolWorker = {
    worker,
    pendingTasks: new Map(),
    activeCount: 0,
  };

  worker.on("message", (resp: { id: number; ok: boolean; symbols?: CodeSymbol[]; error?: string }) => {
    const task = pw.pendingTasks.get(resp.id);
    if (!task) return;
    pw.pendingTasks.delete(resp.id);
    pw.activeCount = Math.max(0, pw.activeCount - 1);
    clearTimeout(task.timeoutHandle);
    if (resp.ok) {
      task.resolve(resp.symbols ?? []);
    } else {
      task.reject(new Error(resp.error ?? "worker error"));
    }
  });

  worker.on("error", (err: Error) => {
    console.error(`[parser-pool] worker error: ${err.message}`);
    failAllTasksAndRespawn(pw, err);
  });

  worker.on("exit", (code: number) => {
    // During shutdown, terminate() is what caused this exit — do not respawn.
    if (shuttingDown) return;
    if (code !== 0) {
      console.error(`[parser-pool] worker exited with code ${code} — respawning`);
      failAllTasksAndRespawn(pw, new Error(`worker exit ${code}`));
    }
  });

  return pw;
}

function failAllTasksAndRespawn(crashed: PoolWorker, err: Error): void {
  for (const task of crashed.pendingTasks.values()) {
    clearTimeout(task.timeoutHandle);
    task.reject(err);
  }
  crashed.pendingTasks.clear();
  crashed.activeCount = 0;

  const idx = pool.indexOf(crashed);
  if (idx !== -1) {
    pool[idx] = spawnWorker();
  }
}

function init(): void {
  if (initialized) return;
  const size = getPoolSize();
  pool = [];
  for (let i = 0; i < size; i++) {
    pool.push(spawnWorker());
  }
  initialized = true;
}

function pickWorker(): PoolWorker {
  // Least-loaded selection — pick worker with fewest active tasks.
  let best = pool[0]!;
  for (const w of pool) {
    if (w.activeCount < best.activeCount) best = w;
  }
  return best;
}

export interface ParseRequest {
  filePath: string;
  source: string;
  language: string;
  relPath: string;
  repoName: string;
}

/**
 * In-thread parse fallback for environments without a built worker entry
 * (vitest, ts-node, dev `tsx` runs). Same logic as parse-worker.ts, just
 * without the worker_threads boundary — a hung parse will hang the caller
 * instead of being terminable, which is acceptable for dev/test.
 */
async function runInThreadParse(req: ParseRequest): Promise<CodeSymbol[]> {
  const { parseFile } = await import("./parser-manager.js");
  const { extractSymbols } = await import("./symbol-extractor.js");
  const tree = await parseFile(req.filePath, req.source);
  if (!tree) return [];
  return extractSymbols(tree, req.relPath, req.source, req.repoName, req.language);
}

/**
 * Parse a file via the worker pool. Resolves with the extracted symbols,
 * rejects on worker error, crash, or task timeout.
 *
 * On timeout the offending worker is `terminate()`d (since WASM may be hung
 * synchronously and won't yield) and replaced with a fresh worker. Other
 * in-flight tasks on the same worker reject with the same timeout error.
 *
 * In dev/test (no built parse-worker.js) falls back to in-thread parsing.
 */
export async function runTreeSitterParse(req: ParseRequest): Promise<CodeSymbol[]> {
  if (!isPoolAvailable()) return runInThreadParse(req);
  if (!initialized) init();
  const taskId = nextTaskId++;
  const w = pickWorker();
  const timeoutMs = getTaskTimeoutMs();

  return new Promise<CodeSymbol[]>((resolveTask, rejectTask) => {
    const timeoutHandle = setTimeout(() => {
      // Synthesize a timeout: pull task from worker, reject, terminate worker
      // so any synchronously-stuck WASM call dies with the process.
      const task = w.pendingTasks.get(taskId);
      if (task) {
        w.pendingTasks.delete(taskId);
        w.activeCount = Math.max(0, w.activeCount - 1);
      }
      const err = new Error(
        `parser-pool task timeout after ${timeoutMs}ms (file: ${req.filePath})`,
      );
      console.warn(
        `[parser-pool] terminating worker due to timeout on ${req.filePath}`,
      );
      // terminate() returns a promise — we don't await it here; the exit
      // handler will respawn the worker and fail any other pending tasks
      // with the appropriate error.
      void w.worker.terminate();
      rejectTask(err);
    }, timeoutMs);

    w.pendingTasks.set(taskId, {
      resolve: resolveTask,
      reject: rejectTask,
      timeoutHandle,
      filePath: req.filePath,
    });
    w.activeCount++;
    w.worker.postMessage({ id: taskId, ...req });
  });
}

/**
 * Tear down the pool. Used by tests; not normally called during MCP server
 * lifetime (workers persist for the life of the process).
 */
export async function shutdownPool(): Promise<void> {
  shuttingDown = true;
  try {
    for (const w of pool) {
      for (const task of w.pendingTasks.values()) {
        clearTimeout(task.timeoutHandle);
        task.reject(new Error("pool shutdown"));
      }
      w.pendingTasks.clear();
      await w.worker.terminate();
    }
    pool = [];
    initialized = false;
  } finally {
    // Reset so a later init() in the same process (tests, or a re-index in the
    // MCP server) can spawn and respawn normally again.
    shuttingDown = false;
  }
}

/** Diagnostics for tests + debugging — current active task counts per worker. */
export function getPoolStats(): { initialized: boolean; workers: number; active: number[] } {
  return {
    initialized,
    workers: pool.length,
    active: pool.map((w) => w.activeCount),
  };
}
