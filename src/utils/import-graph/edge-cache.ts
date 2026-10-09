import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { rename, unlink, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { FileEntry } from "../../types.js";
import type { ImportEdgeExtras } from "./types.js";
import { cleanupOrphanTempFiles } from "../../storage/_shared.js";

/**
 * Remember what each file imported, so an unchanged file is never parsed again.
 *
 * Profiled on tgm-survey-platform (16,896 files, 149 MB of source): reading every file off disk
 * takes 0.8 s; extracting its imports takes 14.8 s — 95% of the graph build. That work is a pure
 * function of the file's content, and most files do not change between two calls.
 *
 * What is cached is the sequence of `addEdge` CALLS a file produced, not the merged edge list. The
 * accumulator merges by `(from, to)` with rules about type-only and star imports, so replaying the
 * same calls through the same accumulator reproduces the merged result exactly — whereas caching
 * the merged output would fork those rules into a second implementation that has to be kept in
 * agreement forever.
 */

/**
 * Bump on any format change — and on any change to which edges a file yields, since an entry is
 * replayed while the file's mtime holds: a mismatch rebuilds rather than misreads. 3: an exported
 * string value (`export default "./x"`) stopped producing an edge.
 */
const FORMAT_VERSION = 3;

export interface CachedEdgeCall {
  to: string;
  extras?: ImportEdgeExtras | undefined;
}

interface Header {
  v: number;
  /**
   * Identity of the FILE SET, not of any one file.
   *
   * An edge is not a function of its source alone: `import "./foo"` resolves against the set of
   * paths that exist, so adding or deleting a file elsewhere can change where an UNCHANGED file
   * points. Per-file mtimes cannot see that. When the set changes the whole cache is discarded —
   * cheap, and the alternative is a graph that is quietly wrong about a file nobody touched.
   */
  fileSetHash: string;
}

export type EdgeCache = Map<string, { mtime: number; calls: CachedEdgeCall[] }>;

export function fileSetHash(files: FileEntry[]): string {
  const hash = createHash("sha1");
  for (const path of files.map((f) => f.path).sort()) {
    hash.update(path);
    hash.update(" ");
  }
  return hash.digest("hex");
}

export function edgeCachePathFor(indexPath: string): string {
  return `${indexPath.replace(/\.index\.json$/, "").replace(/\.index\.db$/, "")}.import-edges.ndjson`;
}

export async function loadEdgeCache(
  indexPath: string,
  files: FileEntry[],
): Promise<EdgeCache | null> {
  const target = edgeCachePathFor(indexPath);
  try {
    if (!(await stat(target)).isFile()) return null;
  } catch {
    return null;
  }

  const expected = fileSetHash(files);
  const cache: EdgeCache = new Map();
  let header: Header | null = null;
  try {
    const rl = createInterface({
      input: createReadStream(target, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      if (header === null) {
        header = JSON.parse(line) as Header;
        // Checked on the FIRST line, before parsing thousands of entries about to be discarded.
        if (header.v !== FORMAT_VERSION || header.fileSetHash !== expected) {
          rl.close();
          return null;
        }
        continue;
      }
      const [path, mtime, calls] = JSON.parse(line) as [
        string,
        number,
        Array<[string, ImportEdgeExtras | null]>,
      ];
      cache.set(path, {
        mtime,
        calls: calls.map(([to, extras]) => (extras === null ? { to } : { to, extras })),
      });
    }
  } catch {
    // Truncated or corrupt. Rebuilding is always correct; reading half a graph is not.
    return null;
  }
  return header === null ? null : cache;
}

export async function saveEdgeCache(
  indexPath: string,
  files: FileEntry[],
  cache: EdgeCache,
): Promise<void> {
  const target = edgeCachePathFor(indexPath);
  // Same reason as `saveBM25Index`: the `catch` below cannot run for a writer that was killed, so
  // without this the temp half survives forever — `prune` skips it because the hash belongs to a
  // live repo.
  await cleanupOrphanTempFiles(target);
  // Temp + rename, like every other artifact here: a process killed mid-write must not leave a
  // truncated file that the next start would read as complete.
  // Per-call nonce, same reason as `saveBM25Index`: two concurrent saves for one target in one
  // process would otherwise share a temp path and splice into one inode. `collectImportEdges` fires
  // this unawaited (`void saveEdgeCache(...)`), so overlapping calls are the expected shape here.
  const temp = `${target}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const out = createWriteStream(temp, { encoding: "utf-8" });
  const write = (line: string): Promise<void> =>
    out.write(line) ? Promise.resolve() : new Promise((r) => out.once("drain", () => r()));
  try {
    const header: Header = { v: FORMAT_VERSION, fileSetHash: fileSetHash(files) };
    await write(`${JSON.stringify(header)}\n`);
    for (const [path, entry] of cache) {
      const calls = entry.calls.map((c) => [c.to, c.extras ?? null]);
      await write(`${JSON.stringify([path, entry.mtime, calls])}\n`);
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.on("error", reject);
    });
    await rename(temp, target);
  } catch {
    await unlink(temp).catch(() => {});
    // Never fail a graph build over its cache. The caller has the edges either way.
  }
}
