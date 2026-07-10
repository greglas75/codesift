import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CATEGORIES } from "./yii3-migration-categories.js";
import type { Yii3MigrationCategoryName } from "./yii3-migration-types.js";

const VENDOR_RE = /(^|\/)(?:vendor|node_modules|runtime|tests\/_data)(\/|$)/;
const SAMPLE_LIMIT = 5;

export interface MigrationScanOptions {
  file_pattern?: string;
  max_samples_per_category?: number;
  include_vendor?: boolean;
}

export interface RawHit {
  file: string;
  line: number;
  snippet: string;
}

export interface CategoryBucket {
  count: number;
  samples: RawHit[];
  files: Set<string>;
}

export interface MigrationScanResult {
  scannedFiles: number;
  buckets: Map<Yii3MigrationCategoryName, CategoryBucket>;
}

export async function scanYii3MigrationSources(
  index: { root: string; files: Array<{ path: string }> },
  options?: MigrationScanOptions,
): Promise<MigrationScanResult> {
  const sampleLimit = options?.max_samples_per_category ?? SAMPLE_LIMIT;
  const phpFiles = index.files.filter(({ path }) =>
    path.endsWith(".php") &&
    (options?.include_vendor || !VENDOR_RE.test(path)) &&
    (!options?.file_pattern || path.includes(options.file_pattern)),
  );
  const buckets = new Map<Yii3MigrationCategoryName, CategoryBucket>();
  for (const cat of CATEGORIES) {
    buckets.set(cat.category, { count: 0, samples: [], files: new Set() });
  }
  const reads = await Promise.allSettled(phpFiles.map(async ({ path }) => ({
    path,
    content: await readFile(join(index.root, path), "utf-8"),
  })));
  for (const read of reads) {
    if (read.status !== "fulfilled") continue;
    collectSourceHits(read.value.path, read.value.content, sampleLimit, buckets);
  }
  return { scannedFiles: phpFiles.length, buckets };
}

function collectSourceHits(
  path: string,
  content: string,
  sampleLimit: number,
  buckets: Map<Yii3MigrationCategoryName, CategoryBucket>,
): void {
  for (const cat of CATEGORIES) {
    const bucket = buckets.get(cat.category)!;
    for (const pattern of cat.patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        bucket.count++;
        bucket.files.add(path);
        if (bucket.samples.length < sampleLimit) {
          bucket.samples.push({
            file: path,
            line: countLinesUntil(content, match.index),
            snippet: extractLineAt(content, match.index),
          });
        }
      }
    }
  }
}

function countLinesUntil(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function extractLineAt(source: string, index: number): string {
  const start = source.lastIndexOf("\n", index) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end === -1 ? source.length : end).trim().slice(0, 200);
}
