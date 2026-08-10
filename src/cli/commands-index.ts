import type { Flags } from "./args.js";
import { getFlag, getBoolFlag, requireArg, parseCommaSeparated, output } from "./args.js";

export function scanEmbeddingMarker(
  tail: string,
  chunk: string,
  marker: string,
): { sawMarker: boolean; tail: string } {
  const combined = tail + chunk;
  return {
    sawMarker: combined.includes(marker),
    tail: marker.length > 1 ? combined.slice(-(marker.length - 1)) : "",
  };
}

// ---------------------------------------------------------------------------
// Index commands
// ---------------------------------------------------------------------------

/**
 * Run the embedding phase in a separate process and wait for it.
 *
 * The child's EXIT CODE is deliberately not trusted. Once onnxruntime has run,
 * the process aborts during native teardown (`mutex lock failed`, exit 134)
 * even though every file was written correctly first — so the child prints a
 * marker after its last successful write and that marker, not the status, is
 * what decides success. See src/cli/embed-child.ts.
 *
 * Failures here are reported but never fatal: BM25 and symbol search work
 * without embeddings, and the index itself is already committed to disk.
 */
async function runEmbeddingChild(repoName: string, rootPath: string): Promise<void> {
  const { getIndexPath } = await import("../storage/index-store.js");
  const { loadConfig } = await import("../config.js");
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");

  const config = loadConfig();
  if (!config.embeddingProvider) return; // lite mode — nothing to embed

  const indexPath = getIndexPath(config.dataDir, rootPath);
  const childScript = join(dirname(fileURLToPath(import.meta.url)), "embed-child.js");
  const { EMBED_CHILD_OK_MARKER } = await import("./embed-child-marker.js");

  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [childScript, indexPath, repoName, rootPath], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, CODESIFT_EMBED_OUT_OF_PROCESS: "0" },
    });

    let sawMarker = false;
    let markerTail = "";
    child.stdout.on("data", (buf: Buffer) => {
      const scan = scanEmbeddingMarker(markerTail, buf.toString(), EMBED_CHILD_OK_MARKER);
      if (scan.sawMarker) sawMarker = true;
      markerTail = scan.tail;
    });
    child.on("error", (err) => {
      process.stderr.write(`[codesift] embedding skipped: ${err.message}\n`);
      resolve();
    });
    child.on("close", (code, signal) => {
      if (!sawMarker) {
        process.stderr.write(
          `[codesift] embedding did not complete (exit ${code ?? signal}) — ` +
            `search falls back to BM25 for this repo.\n`,
        );
      }
      resolve();
    });
  });
}

async function handleIndex(args: string[], flags: Flags): Promise<void> {
  const path = requireArg(args, 0, "path");
  const { indexFolder } = await import("../tools/index-tools.js");

  // Keep onnxruntime out of THIS process; the embedding runs in a child below.
  process.env["CODESIFT_EMBED_OUT_OF_PROCESS"] = "1";

  const result = await indexFolder(path, {
    incremental: getBoolFlag(flags, "incremental"),
    include_paths: parseCommaSeparated(flags, "include-paths"),
    watch: getBoolFlag(flags, "no-watch") === true ? false : undefined,
  });

  // Any in-process embedding scheduled before the opt-out (or by another code
  // path) still has to finish before we exit, or the command reports success
  // having written nothing.
  const { awaitPendingEmbeddings } = await import("../tools/index-tools/folder-indexer.js");
  await awaitPendingEmbeddings();

  const repo = (result as { repo?: string } | null)?.repo;
  const root = (result as { root?: string } | null)?.root;
  if (repo && root) await runEmbeddingChild(repo, root);

  output(result, flags);

  // Without `--no-watch` this command does not return: the watcher keeps the
  // event loop alive so the index stays current. That is the intended default,
  // but a process that prints a finished-looking result and then sits there is
  // indistinguishable from a hang — long enough that I read it as one and spent
  // a `timeout 240` proving otherwise, on a run whose indexing took 125 ms. Say
  // which of the two it is. On stderr, so `codesift index … | jq` still works.
  if (getBoolFlag(flags, "no-watch") !== true) {
    console.error(
      `[codesift] watching ${root ?? path} for changes — Ctrl-C to stop, `
      + "or re-run with --no-watch to exit when indexing finishes.",
    );
  }
}

async function handleIndexRepo(args: string[], flags: Flags): Promise<void> {
  const url = requireArg(args, 0, "url");
  const { indexRepo } = await import("../tools/index-tools.js");

  // Same three protections as handleIndex. Without them this entry point still
  // exits while the fire-and-forget embedding chain is in flight, so the repo
  // ends up with partial or zero embeddings and the command reports success —
  // the exact bug handleIndex was fixed for, left behind on this path.
  process.env["CODESIFT_EMBED_OUT_OF_PROCESS"] = "1";

  const result = await indexRepo(url, {
    branch: getFlag(flags, "branch"),
    include_paths: parseCommaSeparated(flags, "include-paths"),
  });

  const { awaitPendingEmbeddings } = await import("../tools/index-tools/folder-indexer.js");
  await awaitPendingEmbeddings();

  const repo = (result as { repo?: string } | null)?.repo;
  const root = (result as { root?: string } | null)?.root;
  if (repo && root) await runEmbeddingChild(repo, root);

  output(result, flags);
}

async function handleRepos(_args: string[], flags: Flags): Promise<void> {
  const { listAllRepos } = await import("../tools/index-tools.js");
  const result = await listAllRepos();
  output(result, flags);
}

async function handleInvalidate(args: string[], flags: Flags): Promise<void> {
  const repo = requireArg(args, 0, "repo");
  const { invalidateCache } = await import("../tools/index-tools.js");
  const result = await invalidateCache(repo);
  output({ invalidated: result, repo }, flags);
}

async function handleIndexConversations(args: string[], flags: Flags): Promise<void> {
  const projectPath = args[0];
  const { indexConversations } = await import("../tools/conversation-tools.js");

  const result = await indexConversations(projectPath);
  if (!getBoolFlag(flags, "quiet")) {
    output(result, flags);
  }
}

export { handleIndex, handleIndexRepo, handleRepos, handleInvalidate, handleIndexConversations };
