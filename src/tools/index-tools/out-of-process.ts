/**
 * Index and embed in CHILD processes, so the shared daemon's one thread keeps serving.
 *
 * Measured 2026-10-08 on the sessions host: the daemon indexed and embedded a fresh worktree of a
 * 436k-symbol repository on the same thread that answers every MCP client on the machine.
 * `/health` sat at `busy` with `event_loop_lag_ms` ≈ 2,200 for minutes, `get_file_tree` took 9.8 s
 * and `search_symbols` hit its 90 s ceiling. The journal from that night has seeds of an 87,730-file
 * index taking 37–100 s each — a synchronous `VACUUM INTO` — on that same thread.
 *
 * Reproduced with `scripts/bench-index-event-loop.mjs` (4,000 files, 428,000 symbols, a stub
 * embedding server answering instantly): in-process, the index phase alone held the loop up to
 * 687 ms at a time, and the embedding phase that followed held it for **210 s in ≥100 ms slices**
 * over 456 s, worst single stall 5.9 s. No amount of yielding inside that work fixes a thread that
 * is genuinely busy for minutes; the work has to leave the thread. Same harness after the move
 * (second run, farm host): worst stall 7,542 ms → 49 ms, ≥100 ms stalls 225 s → 0, a cheap call's
 * worst latency 2,979 ms → 13 ms; index-only 682 ms → 4 ms. Same 428,000 symbols written.
 *
 * `embed-child.ts` already existed for exactly this reason in the CLI (keeping onnxruntime out of a
 * process that must force-exit), and its contract — everything is read back from the on-disk
 * index, success is a marker printed after the last write, not an exit code — extends to the
 * whole index: the index lives in SQLite (WAL), so a child's writes become visible to the daemon's
 * readers at COMMIT and never half-way. What the daemon still owns is its in-memory state, which
 * the caller of these functions must invalidate when a child finishes (see folder-indexer.ts).
 *
 * Only the long-lived daemon opts in (`enableOutOfProcessIndexing`). The CLI and a per-session
 * stdio server keep indexing in-process: a CLI has no one to starve, and tests exercise the
 * in-process path directly. `CODESIFT_INDEX_OUT_OF_PROCESS=0|1` overrides either way.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EMBED_CHILD_OK_MARKER,
  INDEX_CHILD_ERROR_MARKER,
  INDEX_CHILD_RESULT_MARKER,
  scanEmbeddingMarker,
} from "../../cli/embed-child-marker.js";
import type { IndexFolderResult } from "./types.js";

let daemonOptIn = 0;

/**
 * A child that never exits must not park its repo forever. Runs for one root are chained, so one
 * wedged index child blocked every later `index_folder` and `ensureIndexFresh` for that repo —
 * i.e. every tool call on it — until the daemon restarted; in-process the same hang only froze one
 * promise. The ceilings are generous on purpose: the largest full index measured here took 107
 * minutes, and killing a slow-but-healthy run is worse than waiting for it.
 */
const DEFAULT_INDEX_CHILD_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const DEFAULT_EMBED_CHILD_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** setTimeout fires immediately for anything above 2^31−1 ms, which would kill every child at once. */
const MAX_TIMER_MS = 2_147_483_647;

function childTimeoutMs(envName: string, fallback: number): number {
  const raw = Number(process.env[envName]);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_TIMER_MS) : fallback;
}

/** SIGKILL the child after `ms`; `onTimeout` runs once. The timer never keeps the daemon alive. */
function armChildTimeout(
  child: { kill: (signal: NodeJS.Signals) => boolean; once: (event: "close", cb: () => void) => unknown },
  ms: number,
  onTimeout: () => void,
): void {
  const timer = setTimeout(() => {
    onTimeout();
    child.kill("SIGKILL");
  }, ms);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}

/**
 * Called by the daemon at start; returns the undo for its `close()`. A counter rather than a
 * boolean because tests start and stop several daemons in one process, and one closing must not
 * switch the mode off under another.
 */
export function enableOutOfProcessIndexing(): () => void {
  daemonOptIn++;
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    daemonOptIn = Math.max(0, daemonOptIn - 1);
  };
}

export function shouldIndexOutOfProcess(): boolean {
  const env = process.env["CODESIFT_INDEX_OUT_OF_PROCESS"];
  if (env === "1") return true;
  if (env === "0") return false;
  return daemonOptIn > 0;
}

/**
 * How to start `src/cli/<name>`: the compiled `.js` beside the build, or — when running from source
 * under vitest/tsx, where no `.js` exists — the `.ts` through tsx's loader.
 */
export function childEntryArgs(name: "index-child" | "embed-child"): string[] {
  const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli");
  const js = join(cliDir, `${name}.js`);
  if (existsSync(js)) return [js];
  const ts = join(cliDir, `${name}.ts`);
  const loader = createRequire(import.meta.url).resolve("tsx");
  return ["--import", pathToFileURL(loader).href, ts];
}

/**
 * The heap ceiling is the one flag a child must inherit. The daemon on the sessions host runs with
 * `--max-old-space-size=65536` because a full load of its largest index (1,423,460 symbols) does
 * not fit V8's default ~4 GB; a child started without it would OOM on the very index it was spawned
 * to build. Other flags (inspector, loaders) are deliberately NOT forwarded — a child that opens a
 * debugger port the parent already holds fails to start. NODE_OPTIONS travels in the env anyway.
 */
function heapFlags(): string[] {
  return process.execArgv.filter((a) => a.startsWith("--max-old-space-size") || a.startsWith("--stack-size"));
}

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  // The child is not the daemon. Anything that keys off the transport (stdin handlers, hooks) must
  // not believe it is.
  delete env["CODESIFT_TRANSPORT"];
  return env;
}

export interface IndexChildRequest {
  path: string;
  options: {
    incremental?: boolean | undefined;
    include_paths?: string[] | undefined;
    max_files?: number | undefined;
    force?: boolean | undefined;
  };
}

/**
 * What the child knows that the daemon must act on. `completed` is true exactly when the child's
 * indexFolder ran its whole full-walk path — the only path that, in-process, schedules embedding,
 * starts a watcher and arms the redundant-call short-circuit. A seeded or rejected run does none of
 * those in-process, so the daemon must not do them on its behalf either.
 */
export interface IndexFolderReport {
  completed?: boolean;
  frameworks?: string[];
  /** The index the child wrote — the daemon embeds and watches exactly this one. */
  index_path?: string;
}

export interface IndexChildResponse {
  result: IndexFolderResult;
  report: IndexFolderReport;
}

/**
 * Run indexFolder in a child and return what it returned.
 *
 * stderr is forwarded line-for-line to ours (the daemon log keeps every `[codesift]` line it had
 * when this ran in-process) and its tail is kept, because an OOM-killed child prints nothing on
 * stdout and "exited without a result" is useless without the reason.
 */
/**
 * At most this many index children at once, across roots. Runs serialise per root already, but N new
 * worktrees requested together started N full-index children, each holding a whole index in its own
 * heap with the daemon's heap flag — on the host whose daemon was already OOM-looping.
 */
const DEFAULT_INDEX_CHILD_CONCURRENCY = 2;
let runningIndexChildren = 0;
const waitingIndexChildren: Array<() => void> = [];

function indexChildConcurrency(): number {
  const raw = Number(process.env["CODESIFT_INDEX_CHILD_CONCURRENCY"]);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_INDEX_CHILD_CONCURRENCY;
}

async function withIndexChildSlot<T>(work: () => Promise<T>): Promise<T> {
  if (runningIndexChildren >= indexChildConcurrency()) {
    // The releaser hands its slot straight to us (it does not decrement), so a caller arriving in
    // between cannot take it and push the count past the cap.
    await new Promise<void>((resolve) => waitingIndexChildren.push(resolve));
  } else {
    runningIndexChildren++;
  }
  try {
    return await work();
  } finally {
    const next = waitingIndexChildren.shift();
    if (next) next();
    else runningIndexChildren--;
  }
}

/**
 * `onSpawn` runs when the child actually starts — after any wait for a slot — with the promise of
 * its outcome. The write barrier hangs off it: a run still queued for a slot is not writing.
 */
export function runIndexChild(
  request: IndexChildRequest,
  hooks?: { onSpawn?: (outcome: Promise<IndexChildResponse>) => void },
): Promise<IndexChildResponse> {
  return withIndexChildSlot(() => {
    const outcome = spawnIndexChild(request);
    hooks?.onSpawn?.(outcome);
    return outcome;
  });
}

function spawnIndexChild(request: IndexChildRequest): Promise<IndexChildResponse> {
  return new Promise<IndexChildResponse>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...heapFlags(), ...childEntryArgs("index-child"), JSON.stringify(request)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv({
          // No recursion: the child indexes in-process.
          CODESIFT_INDEX_OUT_OF_PROCESS: "0",
          // ...and does NOT embed. Embedding is scheduled by the daemon as its own child, through
          // the same per-repo queue that serialised it in-process.
          CODESIFT_EMBED_OUT_OF_PROCESS: "1",
        }),
      },
    );

    let stdout = "";
    let stderrTail = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk).slice(-2_000);
    });
    let timedOut = false;
    const timeoutMs = childTimeoutMs("CODESIFT_INDEX_CHILD_TIMEOUT_MS", DEFAULT_INDEX_CHILD_TIMEOUT_MS);
    armChildTimeout(child, timeoutMs, () => { timedOut = true; });
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      // The result marker is read FIRST: a child that committed and printed its result just before
      // the timer fired succeeded, and reporting it as killed would discard a finished index.
      for (const line of stdout.split("\n")) {
        if (line.startsWith(INDEX_CHILD_RESULT_MARKER)) {
          try {
            const parsed = JSON.parse(line.slice(INDEX_CHILD_RESULT_MARKER.length)) as Partial<IndexChildResponse>;
            // The daemon adopts this result (cache keys, watcher root): a malformed one must fail
            // here, by name, not as a TypeError somewhere inside the adoption.
            if (
              typeof parsed?.result?.repo !== "string" ||
              typeof parsed.result.root !== "string" ||
              typeof parsed.report !== "object" ||
              parsed.report === null ||
              Array.isArray(parsed.report)
            ) {
              throw new Error(`index child for ${request.path} returned a malformed result`);
            }
            resolve(parsed as IndexChildResponse);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
          return;
        }
        if (line.startsWith(INDEX_CHILD_ERROR_MARKER)) {
          // The child's indexFolder threw: surface the SAME message the in-process call would have.
          reject(new Error(line.slice(INDEX_CHILD_ERROR_MARKER.length)));
          return;
        }
      }
      if (timedOut) {
        reject(new Error(`index child for ${request.path} killed after ${timeoutMs} ms without a result`));
        return;
      }
      const tail = stderrTail.trim().split("\n").slice(-3).join(" | ");
      reject(new Error(
        `index child for ${request.path} exited (${code ?? signal}) without a result` +
          (tail ? ` — last stderr: ${tail}` : ""),
      ));
    });
  });
}

/**
 * Embed a repo in a child: the CLI's `embed-child`, unchanged, now shared with the daemon.
 *
 * The child's EXIT CODE is deliberately not trusted. Once onnxruntime has run, the process aborts
 * during native teardown (`mutex lock failed`, exit 134) even though every file was written
 * correctly first — so the child prints a marker after its last successful write and that marker,
 * not the status, decides success. See src/cli/embed-child.ts.
 *
 * Never rejects: embedding is non-fatal to indexing (BM25 and symbol search work without it).
 * Resolves true when the marker was seen.
 */
export function runEmbeddingChildProcess(
  repoName: string,
  rootPath: string,
  indexPath: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn(
        process.execPath,
        [...heapFlags(), ...childEntryArgs("embed-child"), indexPath, repoName, rootPath],
        {
          stdio: ["ignore", "pipe", "inherit"],
          env: childEnv({ CODESIFT_EMBED_OUT_OF_PROCESS: "0", CODESIFT_INDEX_OUT_OF_PROCESS: "0" }),
        },
      );
    } catch (err) {
      process.stderr.write(`[codesift] embedding skipped: ${(err as Error).message}\n`);
      resolve(false);
      return;
    }

    armChildTimeout(
      child,
      childTimeoutMs("CODESIFT_EMBED_CHILD_TIMEOUT_MS", DEFAULT_EMBED_CHILD_TIMEOUT_MS),
      () => process.stderr.write(`[codesift] embedding child for ${repoName} timed out — killing it.\n`),
    );
    let sawMarker = false;
    let markerTail = "";
    child.stdout.on("data", (buf: Buffer) => {
      const scan = scanEmbeddingMarker(markerTail, buf.toString(), EMBED_CHILD_OK_MARKER);
      if (scan.sawMarker) sawMarker = true;
      markerTail = scan.tail;
    });
    child.on("error", (err) => {
      process.stderr.write(`[codesift] embedding skipped: ${err.message}\n`);
      resolve(false);
    });
    child.on("close", (code, signal) => {
      if (!sawMarker) {
        process.stderr.write(
          `[codesift] embedding did not complete for ${repoName} (exit ${code ?? signal}) — ` +
            `search falls back to BM25 for this repo.\n`,
        );
      }
      resolve(sawMarker);
    });
  });
}
