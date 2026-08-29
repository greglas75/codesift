/**
 * Embedding worker process.
 *
 * Exists solely to keep onnxruntime OUT of the CLI's main process. Once an ORT
 * session has been created, any forced exit aborts in native teardown
 * (`libc++abi ... mutex lock failed: Invalid argument`, exit 134) — reproduced
 * with the memory arena on and off, via process.exit() and reallyExit(), with
 * and without a prior dispose(). Only a natural exit is clean, and the CLI
 * cannot rely on one because some handle keeps its event loop open.
 *
 * Splitting the work out sidesteps the conflict instead of fighting it: the
 * parent never loads ORT, so it may force-exit safely, and this child does
 * nothing after its writes that an abort could corrupt. The parent therefore
 * treats "files written and valid" as success regardless of this process's exit
 * code — see runEmbeddingChild.
 *
 * Everything it needs is read back from the on-disk index, so no parsing is
 * repeated: the index already carries both the symbols and the file list.
 */
import { loadIndex } from "../storage/index-store.js";
import { loadConfig } from "../config.js";
import { embedSymbols, embedChunks } from "../tools/index-tools/parse.js";

import { EMBED_CHILD_OK_MARKER } from "./embed-child-marker.js";
import { exitWhenOrphaned, exitWhenRootGone } from "./orphan-guard.js";

async function main(): Promise<void> {
  // A detached worker that outlives its parent has no consumer for its work.
  exitWhenOrphaned();
  const [indexPath, repoName, rootPath] = process.argv.slice(2);
  // The ppid guard cannot catch a tree that disappears while its parent keeps working: measured
  // 2026-08-29, that ran 1 h 10 min at 813% CPU on a worktree deleted minutes after the start.
  if (rootPath) exitWhenRootGone(rootPath);
  if (!indexPath || !repoName || !rootPath) {
    process.stderr.write("embed-child: expected <indexPath> <repoName> <rootPath>\n");
    process.exitCode = 2;
    return;
  }

  const index = await loadIndex(indexPath);
  if (!index) {
    process.stderr.write(`embed-child: index not found at ${indexPath}\n`);
    process.exitCode = 2;
    return;
  }

  const config = loadConfig();
  if (!config.embeddingProvider) {
    // Lite mode / no provider — nothing to do, and saying so is not an error.
    process.stdout.write(`${EMBED_CHILD_OK_MARKER}\n`);
    return;
  }

  // Both report failure instead of throwing: embedding is non-fatal to INDEXING,
  // but it is the entire job of this process, so a failure here must not be
  // reported to the parent as a completed run. The marker is the parent's only
  // success signal, and it used to be written unconditionally — a repo whose
  // embedding threw looked identical to one that finished.
  const symbolsOk = await embedSymbols(index.symbols, indexPath, repoName, config);
  const chunksOk = await embedChunks(index.files, rootPath, repoName, indexPath, config, index.symbols);
  if (!symbolsOk || !chunksOk) {
    process.stderr.write(
      `embed-child: ${repoName} incomplete (symbols=${symbolsOk ? "ok" : "failed"}, ` +
      `chunks=${chunksOk ? "ok" : "failed"}) — see the logged reason above\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${EMBED_CHILD_OK_MARKER}\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`embed-child: ${message}\n`);
  process.exitCode = 1;
});
