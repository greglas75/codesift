import { createReadStream, createWriteStream } from "node:fs";
import { rename, unlink, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { BM25Index } from "./bm25.js";
import type { CodeIndex, CodeSymbol } from "../types.js";
import { cleanupOrphanTempFiles } from "../storage/_shared.js";

/**
 * Persist a BM25 index next to the code index it was built from.
 *
 * Rebuilding costs 10.04 s on the largest repo here (352,166 symbols, 12.9M tokens) and is paid
 * once per repo per process — so every daemon restart, and every eviction under the cache budget,
 * charges it again. Measured alternative on the same index: reconstructing the maps from flat
 * arrays is **0.70 s** and reading 400 MB off this disk is 0.06 s. 13x, and the reason is that the
 * expensive half of a build is TOKENISING every symbol, not assembling the maps.
 *
 * Line-delimited, not one JSON document: `JSON.stringify` on the whole structure exceeds V8's
 * maximum string length and throws outright. The same reason `embeddings.ndjson` is streamed.
 *
 * `symbols` is deliberately NOT written. Every one of those objects is already in the code index
 * that gets loaded first, so persisting them would double the bytes on a disk that is, on this
 * machine, the actual bottleneck. They are reattached on load from that index.
 *
 * ---------------------------------------------------------------------------
 * v2: symbol ids are interned. Why the format changed (measured 2026-09-27)
 * ---------------------------------------------------------------------------
 *
 * v1 wrote the full symbol id — `repo:file:name:line`, averaging 121 characters — into every
 * postings entry. A document appears once per token it contains, so each id was written many times:
 * measured on a real 53 MB index, 398,712 postings pairs over 17,410 distinct ids, i.e. **22.9
 * repeats each**, and **91% of the file was id strings**.
 *
 * That made the 13x claim above false in practice, which is what this comment used to promise. On
 * the largest conversation index here (159,626 turns) v1 produced a **1,975 MB** file, and loading
 * it was only **1.4x** faster than rebuilding from scratch — parsing two billion characters of
 * repeated strings costs about what tokenising the corpus costs. The cache was not worth its disk:
 * 47.78 GB of `.bm25.ndjson` across this machine's code repos.
 *
 * So the ids move into a table written before the postings, and postings reference them by index.
 * The table is chunked because one JSON array of every id exceeds V8's maximum string length on a
 * large repo — the same reason this file is line-delimited at all.
 *
 * A number where v1 had a string is the only wire change, and the reader accepts BOTH: an id absent
 * from the table (which cannot happen for an index this writer produced, but would be a silent wrong
 * answer if it did) is written as a string and read as one. The version bump is what migrates
 * existing caches — `isStale` rejects a v1 header, the index rebuilds, and the rewrite is v2.
 */

/** Bump on any format change: a mismatch rebuilds rather than misreads. */
const FORMAT_VERSION = 2;

/**
 * Symbol ids per `["s", …]` line.
 *
 * Bounded for the same reason the file is line-delimited: at 121 characters an id, one array of a
 * large repo's 352,166 ids is 42 MB of JSON — comfortable, but the bound is what keeps a repo ten
 * times larger from hitting the string ceiling instead of degrading.
 */
const ID_CHUNK = 20_000;


type FieldName = "name" | "signature" | "docstring" | "body" | "comments";
const FIELDS: FieldName[] = ["name", "signature", "docstring", "body", "comments"];

interface Header {
  v: number;
  docCount: number;
  avg: Record<FieldName, number>;
  tot: Record<FieldName, number>;
  /** Everything needed to prove the cache still describes THIS index — see isStale. */
  symbolCount: number;
  fileCount: number;
  indexUpdatedAt: number;
}

function headerFor(index: BM25Index, code: CodeIndex): Header {
  return {
    v: FORMAT_VERSION,
    docCount: index.docCount,
    avg: index.avgFieldLengths,
    tot: index.totalFieldLengths,
    symbolCount: code.symbols.length,
    fileCount: code.files.length,
    indexUpdatedAt: code.updated_at ?? code.created_at ?? 0,
  };
}

/**
 * A cache that does not describe the current index is worse than no cache: it returns confident,
 * wrong search results, which is the one failure mode a search tool must never have. So the check
 * is deliberately cheap AND strict — any disagreement rebuilds, and nothing here tries to repair a
 * partial match.
 */
function isStale(header: Header, code: CodeIndex): boolean {
  if (header.v !== FORMAT_VERSION) return true;
  if (header.symbolCount !== code.symbols.length) return true;
  if (header.fileCount !== code.files.length) return true;
  return header.indexUpdatedAt !== (code.updated_at ?? code.created_at ?? 0);
}

/**
 * The format version this build writes, so `prune` can reclaim files no build can read.
 *
 * A format bump strands every existing file: `isStale` rejects the old header and the index rebuilds,
 * but the bytes only go away when that repo is indexed again — and a repo nobody touches is never
 * indexed again. Measured at the v1 -> v2 bump: 47.78 GB of `.bm25.ndjson` on this machine, all of it
 * unreadable the moment the version changed. The shared embedding cache has the same hazard and the
 * same answer (`currentSharedCacheFilename`).
 */
export function bm25FormatVersion(): number {
  return FORMAT_VERSION;
}

export function bm25PathFor(indexPath: string): string {
  return indexPath.replace(/\.index\.json$/, "").replace(/\.index\.db$/, "") + ".bm25.ndjson";
}

export async function saveBM25Index(
  indexPath: string,
  index: BM25Index,
  code: CodeIndex,
): Promise<void> {
  const target = bm25PathFor(indexPath);
  // Reclaim temp halves left by a writer that was KILLED rather than failed — the `catch` below
  // only runs when the write throws. This writer produces the largest orphans in the data dir by a
  // wide margin: measured 2026-09-27, 13 abandoned `.bm25.ndjson.tmp.*` holding 6.93 GB of the
  // 7.17 GB total, the oldest three weeks old. It was the only large-artifact writer that never
  // swept, and `prune` cannot reach these either — its sweep skips any hash belonging to a LIVE
  // repo, which is what every one of those 13 was.
  await cleanupOrphanTempFiles(target);
  // Temp + rename, like every other artifact here: a process killed mid-write must not leave a
  // truncated file that the next start would read as a complete index.
  //
  // The name carries a per-call NONCE, not just the pid. Temp-then-rename makes ONE writer's write
  // atomic and says nothing about two writers sharing a temp NAME: with `.tmp.<pid>` alone, two
  // concurrent misses for the same repo IN THE SAME PROCESS — the shared daemon's normal shape, and
  // there is no single-flight guard on the BM25 miss path the way `withIndexLoadSlot` guards index
  // loads — open the same path, interleave into one inode, and whichever renames last wins with
  // spliced content. `atomicWriteFile` in `storage/_shared.ts` already carried this reasoning in its
  // own comment; this writer did not. Found by the behaviour audit of this release, against a comment
  // of mine that asserted the opposite.
  const temp = `${target}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const out = createWriteStream(temp, { encoding: "utf-8" });

  const write = (line: string): Promise<void> =>
    out.write(line) ? Promise.resolve() : new Promise((r) => out.once("drain", () => r()));

  try {
    await write(`${JSON.stringify(headerFor(index, code))}\n`);

    // The id table goes out FIRST, because postings reference it by position and the reader is a
    // single forward pass over the stream. `fieldLengths` is the authoritative document set: it has
    // exactly one entry per indexed document, which is what a posting can refer to.
    const idIndex = new Map<string, number>();
    for (const id of index.fieldLengths.keys()) idIndex.set(id, idIndex.size);
    const ids = [...idIndex.keys()];
    for (let start = 0; start < ids.length; start += ID_CHUNK) {
      await write(`${JSON.stringify(["s", start, ids.slice(start, start + ID_CHUNK)])}\n`);
    }

    for (const field of FIELDS) {
      for (const [token, postings] of index.fields[field]) {
        // Flat [ref, tf, ref, tf, …]: half the JSON of an array of pairs, and it rebuilds with one
        // loop rather than a destructuring per entry. `ref` is the id's index in the table above, or
        // the id itself when it is not in it — see the v2 note in the file header.
        const flat: (string | number)[] = [];
        for (const [id, tf] of postings) { flat.push(idIndex.get(id) ?? id); flat.push(tf); }
        await write(`${JSON.stringify(["p", field, token, flat])}\n`);
      }
    }
    for (const [id, lengths] of index.fieldLengths) {
      const ref = idIndex.get(id) ?? id;
      await write(`${JSON.stringify(["l", ref, lengths.name, lengths.signature, lengths.docstring, lengths.body, lengths.comments])}\n`);
    }
    for (const [file, score] of index.centrality) {
      await write(`${JSON.stringify(["c", file, score])}\n`);
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.on("error", reject);
    });
    await rename(temp, target);
  } catch {
    await unlink(temp).catch(() => {});
    // Never fail a build over its cache. The caller has a working index in memory either way.
  }
}

/**
 * A postings reference back to a symbol id.
 *
 * `null`, not a fallback, when a numeric reference has no entry in the table: that means the table
 * was truncated or the chunk that held it was lost, and inventing an id there would produce an index
 * that searches cleanly and returns the wrong symbol. The caller treats `null` the same as a corrupt
 * file and rebuilds, which is always correct.
 */
function resolveId(ref: unknown, idTable: string[]): string | null {
  if (typeof ref === "string") return ref;
  if (typeof ref !== "number") return null;
  return idTable[ref] ?? null;
}

export async function loadBM25Index(
  indexPath: string,
  code: CodeIndex,
): Promise<BM25Index | null> {
  const target = bm25PathFor(indexPath);
  try {
    if (!(await stat(target)).isFile()) return null;
  } catch {
    return null;
  }

  const fields: Record<FieldName, Map<string, Map<string, number>>> = {
    name: new Map(), signature: new Map(), docstring: new Map(),
    body: new Map(), comments: new Map(),
  };
  const fieldLengths = new Map<string, Record<FieldName, number>>();
  const centrality = new Map<string, number>();
  const idTable: string[] = [];
  let header: Header | null = null;

  try {
    const rl = createInterface({ input: createReadStream(target, { encoding: "utf-8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      if (header === null) {
        header = JSON.parse(line) as Header;
        // Checked BEFORE reading 8.9M posting entries, not after: a stale cache should cost one
        // line, not a full parse followed by a discard.
        if (isStale(header, code)) { rl.close(); return null; }
        continue;
      }
      const row = JSON.parse(line) as unknown[];
      const kind = row[0];
      if (kind === "s") {
        // Chunks arrive in order and each states its own start, so a reordered or missing chunk
        // leaves holes rather than shifting every id after it by one — a shift would attach the
        // wrong symbol to every posting and still look like a valid index.
        //
        // The parameters come off disk, so they are bounded before use: a corrupt `start` would
        // index the array at an arbitrary offset (V8 drops it into dictionary mode and the load
        // degrades into a crawl), and a corrupt row shape would put non-strings in the table.
        // A cache that cannot be trusted is rebuilt — that is always correct, and the alternative
        // here is a slow death on a file nobody can read anyway.
        const start = row[1];
        const chunk = row[2];
        // Bounded by the file's OWN header rather than a round constant: the table can never hold
        // more ids than the index has documents, and `symbolCount` was already read and validated
        // against the live index by `isStale` above. An arbitrary 50M ceiling still permitted a
        // 50M-element sparse array from one corrupt integer; this permits exactly what the file
        // claims to contain. Tightened after the cross-model review called the constant too loose.
        const maxIds = header.symbolCount;
        if (typeof start !== "number" || !Number.isInteger(start) || start < 0 ||
            !Array.isArray(chunk) || chunk.length > maxIds || start + chunk.length > maxIds) {
          return null;
        }
        for (let i = 0; i < chunk.length; i++) {
          const id = chunk[i];
          if (typeof id !== "string") return null;
          // Two chunks claiming the same slot is not something this writer can produce, so a file
          // that does is corrupt — and taking the later one would attach a DIFFERENT symbol to every
          // posting that referenced it, which searches cleanly and answers wrongly. Rebuild instead.
          if (idTable[start + i] !== undefined) return null;
          idTable[start + i] = id;
        }
      } else if (kind === "p") {
        const field = row[1] as FieldName;
        const flat = row[3] as (string | number)[];
        const postings = new Map<string, number>();
        for (let i = 0; i < flat.length; i += 2) {
          const id = resolveId(flat[i], idTable);
          if (id === null) return null;
          postings.set(id, flat[i + 1] as number);
        }
        fields[field].set(row[2] as string, postings);
      } else if (kind === "l") {
        const id = resolveId(row[1], idTable);
        if (id === null) return null;
        fieldLengths.set(id, {
          name: row[2] as number, signature: row[3] as number, docstring: row[4] as number,
          body: row[5] as number, comments: row[6] as number,
        });
      } else if (kind === "c") {
        centrality.set(row[1] as string, row[2] as number);
      }
    }
  } catch {
    // Truncated, corrupt, or written by a version that disagrees. Rebuilding is always correct;
    // reading half an index is not.
    return null;
  }

  if (header === null) return null;

  // Reattached rather than persisted — see the file header. The map must be built the same way the
  // builder does it (last write wins), because symbol ids are documented as non-unique.
  const symbols = new Map<string, CodeSymbol>();
  for (const symbol of code.symbols) symbols.set(symbol.id, symbol);

  return {
    fields,
    avgFieldLengths: header.avg,
    docCount: header.docCount,
    symbols,
    centrality,
    fieldLengths,
    totalFieldLengths: header.tot,
  };
}
