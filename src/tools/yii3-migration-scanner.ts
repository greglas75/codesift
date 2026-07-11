import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
  readFailures: number;
  buckets: Map<Yii3MigrationCategoryName, CategoryBucket>;
}

export async function scanYii3MigrationSources(
  index: { root: string; files: Array<{ path: string }> },
  options?: MigrationScanOptions,
): Promise<MigrationScanResult> {
  const sampleLimit = options?.max_samples_per_category ?? SAMPLE_LIMIT;
  const phpFiles = index.files.filter(({ path }) =>
    path.endsWith(".php") &&
    isPathWithinRoot(index.root, path) &&
    (options?.include_vendor || !VENDOR_RE.test(path)) &&
    (!options?.file_pattern || path.includes(options.file_pattern)),
  );
  const buckets = new Map<Yii3MigrationCategoryName, CategoryBucket>();
  for (const cat of CATEGORIES) {
    buckets.set(cat.category, { count: 0, samples: [], files: new Set() });
  }
  const canonicalRoot = await realpath(index.root);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const reads = await Promise.allSettled(phpFiles.map(async ({ path }) => {
    const requestedPath = resolve(index.root, path);
    const handle = await open(
      requestedPath,
      constants.O_RDONLY | noFollow,
    );
    try {
      const opened = await handle.stat();
      const canonicalPath = await realpath(requestedPath);
      const current = await stat(canonicalPath);
      if (!isResolvedWithinRoot(canonicalRoot, canonicalPath) ||
          opened.dev !== current.dev || opened.ino !== current.ino ||
          opened.nlink > 1) {
        throw new Error(`Indexed path escapes repository root: ${path}`);
      }
      return { path, content: await handle.readFile("utf-8") };
    } finally {
      await handle.close();
    }
  }));
  for (const read of reads) {
    if (read.status !== "fulfilled") continue;
    collectSourceHits(read.value.path, read.value.content, sampleLimit, buckets);
  }
  return {
    scannedFiles: reads.filter((read) => read.status === "fulfilled").length,
    readFailures: reads.filter((read) => read.status === "rejected").length,
    buckets,
  };
}

function isPathWithinRoot(root: string, path: string): boolean {
  return !isAbsolute(path) && isResolvedWithinRoot(resolve(root), resolve(root, path));
}

function isResolvedWithinRoot(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
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
