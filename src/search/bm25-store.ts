import { createReadStream, createWriteStream } from "node:fs";
import { rename, unlink, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { BM25Index } from "./bm25.js";
import type { CodeIndex, CodeSymbol } from "../types.js";

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
 */

/** Bump on any format change: a mismatch rebuilds rather than misreads. */
const FORMAT_VERSION = 1;

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

export function bm25PathFor(indexPath: string): string {
  return indexPath.replace(/\.index\.json$/, "").replace(/\.index\.db$/, "") + ".bm25.ndjson";
}

export async function saveBM25Index(
  indexPath: string,
  index: BM25Index,
  code: CodeIndex,
): Promise<void> {
  const target = bm25PathFor(indexPath);
  // Temp + rename, like every other artifact here: a process killed mid-write must not leave a
  // truncated file that the next start would read as a complete index.
  const temp = `${target}.tmp.${process.pid}`;
  const out = createWriteStream(temp, { encoding: "utf-8" });

  const write = (line: string): Promise<void> =>
    out.write(line) ? Promise.resolve() : new Promise((r) => out.once("drain", () => r()));

  try {
    await write(`${JSON.stringify(headerFor(index, code))}\n`);
    for (const field of FIELDS) {
      for (const [token, postings] of index.fields[field]) {
        // Flat [id, tf, id, tf, …]: half the JSON of an array of pairs, and it rebuilds with one
        // loop rather than a destructuring per entry.
        const flat: (string | number)[] = [];
        for (const [id, tf] of postings) { flat.push(id); flat.push(tf); }
        await write(`${JSON.stringify(["p", field, token, flat])}\n`);
      }
    }
    for (const [id, lengths] of index.fieldLengths) {
      await write(`${JSON.stringify(["l", id, lengths.name, lengths.signature, lengths.docstring, lengths.body, lengths.comments])}\n`);
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
      if (kind === "p") {
        const field = row[1] as FieldName;
        const flat = row[3] as (string | number)[];
        const postings = new Map<string, number>();
        for (let i = 0; i < flat.length; i += 2) postings.set(flat[i] as string, flat[i + 1] as number);
        fields[field].set(row[2] as string, postings);
      } else if (kind === "l") {
        fieldLengths.set(row[1] as string, {
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
