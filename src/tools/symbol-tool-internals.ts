import type { BM25Index } from "../search/bm25.js";
import type { IndexSummary } from "../storage/sqlite-index-store.js";
import { getBM25Index, getIndexSummary } from "./index-tools.js";

export const MAX_REFERENCES = 100;
export const MAX_CONTEXT_LENGTH = 200;

const NOISE_PATH_PREFIXES = [
  ".next/",
  "dist/",
  "build/",
  "coverage/",
  "node_modules/",
  "__snapshots__/",
];
const NOISE_EXTENSIONS = new Set([
  ".snap",
  ".lock",
  ".map",
  ".svg",
  ".png",
  ".jpg",
  ".ico",
  ".woff",
  ".woff2",
]);

export function isNoisePath(filePath: string): boolean {
  // Repo-relative paths carry `\` on win32 (`dist\x.js`), which a `/`-suffixed prefix never matches.
  const posixPath = filePath.replace(/\\/g, "/");
  if (NOISE_PATH_PREFIXES.some((prefix) => posixPath.startsWith(prefix))) return true;
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 && NOISE_EXTENSIONS.has(filePath.slice(dot));
}

/**
 * The repo's summary, for tools that read the file list and the root (the symbols they need come
 * from narrow reads — no tool here loads the whole index any more).
 *
 * `IndexSummary` has no `symbols` field at all rather than an empty one, so a caller that needs
 * symbols fails to compile instead of reading an empty array as "this repo has none". That is the
 * property that makes converting a tool to it safe: the compiler, not review, decides whether the
 * tool was really in this bucket.
 */
export async function requireIndexSummary(repo: string): Promise<IndexSummary> {
  const summary = await getIndexSummary(repo);
  if (!summary) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }
  return summary;
}

export async function requireBM25Index(repo: string): Promise<BM25Index> {
  const index = await getBM25Index(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }
  return index;
}

export function wordBoundaryPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![$_\\p{ID_Continue}])${escaped}(?![$_\\u200C\\u200D\\p{ID_Continue}])`, "u");
}
