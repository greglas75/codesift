import type { BM25Index } from "../search/bm25.js";
import type { CodeIndex } from "../types.js";
import { getBM25Index, getCodeIndex } from "./index-tools.js";

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
  if (NOISE_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix))) return true;
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 && NOISE_EXTENSIONS.has(filePath.slice(dot));
}

export async function requireCodeIndex(repo: string): Promise<CodeIndex> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }
  return index;
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
  return new RegExp(`\\b${escaped}\\b`);
}
