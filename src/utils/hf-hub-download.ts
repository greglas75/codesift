// HuggingFace Hub model-file download + local cache utility.
// Atomic write: streams to <final>.tmp.<pid>.<seq>, then renames.
// Cache hit: returns immediately if the final path already exists.
// Concurrency: concurrent calls for the same finalPath share one download.

import { mkdir, rename, unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pumpToFile } from "./hf-download-stream.js";

export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; // 500 MB
export const DOWNLOAD_TIMEOUT_MS = 30_000;

const HF_BASE = "https://huggingface.co";

// CRITICAL-1 fix: monotonic counter for unique tmp paths within the process
let tmpSeq = 0;

// CRITICAL-1 fix: in-process dedup — second concurrent call for same file awaits first
const inflight = new Map<string, Promise<string>>();

function slugify(modelId: string): string {
  // Injective: percent-encode "%" and "/" so any two distinct modelIds produce distinct slugs.
  // "%" → "%25" first (must come before the "/" encoding), "/" → "%2F".
  // Result is FS-safe on all major platforms and human-readable.
  return modelId.replaceAll("%", "%25").replaceAll("/", "%2F");
}

function validateInput(modelId: string, filename: string): void {
  if (!modelId || !modelId.trim())
    throw new Error("ensureModelFile: modelId must not be empty");
  if (!filename || !filename.trim())
    throw new Error("ensureModelFile: filename must not be empty");
  if (modelId.includes("..") || modelId.startsWith("/"))
    throw new Error(`ensureModelFile: invalid modelId — path traversal rejected: "${modelId}"`);
  if (filename.includes("..") || filename.startsWith("/"))
    throw new Error(`ensureModelFile: invalid filename — path traversal rejected: "${filename}"`);
  // FIX-1: model files are root-level; "/" in filename would silently create un-mkdir'd subpaths
  if (filename.includes("/"))
    throw new Error(`ensureModelFile: invalid filename — must not contain path separators: "${filename}"`);
}

/** Returns true when `path` exists AND has size > 0. */
function isCacheValid(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

async function downloadToCache(
  modelId: string,
  filename: string,
  cacheDir: string,
  opts?: { timeoutMs?: number; maxBytes?: number; inactivityMs?: number },
): Promise<string> {
  validateInput(modelId, filename);

  const slug = slugify(modelId);
  const modelDir = join(cacheDir, slug);
  const finalPath = join(modelDir, filename);

  // FIX-4: cache hit only valid when file is non-empty
  if (isCacheValid(finalPath)) {
    return finalPath;
  }

  await mkdir(modelDir, { recursive: true });

  const url = `${HF_BASE}/${modelId}/resolve/main/${filename}`;
  const timeoutMs = opts?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const inactivityMs = opts?.inactivityMs;

  // Use a manual AbortController so we can cancel ONLY the connect phase (headers).
  // AbortSignal.timeout() would bound the entire response consumption including body
  // streaming, which breaks large-but-active downloads that take >timeoutMs total.
  // Instead: fire the timer before fetch(), clear it immediately after headers arrive,
  // and rely on pumpToFile's per-chunk inactivity logic for the body phase.
  const ctrl = new AbortController();
  const connectTimer = setTimeout(
    () => ctrl.abort(new Error(`ensureModelFile: connect timeout after ${timeoutMs}ms — ${url}`)),
    timeoutMs,
  );

  let response: Response;
  try {
    response = await fetch(url, { signal: ctrl.signal });
  } finally {
    // Headers received (or fetch rejected) — connect phase is done, cancel timer.
    clearTimeout(connectTimer);
  }

  if (!response.ok) {
    throw new Error(
      `ensureModelFile: HTTP ${response.status} ${response.statusText} — failed to download ${url}`,
    );
  }

  // FIX-3: if fetch auto-decompressed the body, content-length reflects the compressed size.
  // In that case, skip both the pre-check and the completeness verification.
  const contentEncoding = response.headers.get("content-encoding");
  const isCompressed =
    contentEncoding !== null &&
    contentEncoding.toLowerCase() !== "identity";

  // Cap check via content-length header (before reading body)
  const contentLengthHeader = response.headers.get("content-length");
  let contentLength: number | null = null;
  if (!isCompressed && contentLengthHeader !== null) {
    const bytes = parseInt(contentLengthHeader, 10);
    if (!isNaN(bytes)) {
      if (bytes > maxBytes) {
        throw new Error(
          `ensureModelFile: content-length ${bytes} exceeds 500 MB cap (${maxBytes} bytes) for ${url}`,
        );
      }
      contentLength = bytes;
    }
  }

  const body = response.body;
  if (!body) throw new Error(`ensureModelFile: response body is null for ${url}`);

  // CRITICAL-1 fix: unique tmp path using pid + monotonic sequence
  const tmpPath = `${finalPath}.tmp.${process.pid}.${++tmpSeq}`;

  try {
    const bytesWritten = await pumpToFile(body, tmpPath, {
      maxBytes,
      expectedLength: contentLength,
      url,
      ...(inactivityMs !== undefined && { inactivityMs }),
    });
    // Model/tokenizer files are never legitimately empty — treat 0-byte result as a
    // download failure so the caller re-downloads rather than caching a useless file.
    if (bytesWritten === 0) {
      throw new Error(`ensureModelFile: empty download (0 bytes) — ${url}`);
    }
    await rename(tmpPath, finalPath);
  } catch (err: unknown) {
    // Clean up partial / tmp file before rethrowing
    try { await unlink(tmpPath); } catch { /* already gone */ }
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.message.includes("ensureModelFile:")) throw err;
    throw new Error(`ensureModelFile: download failed — ${msg}`, { cause: err });
  }

  return finalPath;
}

export async function ensureModelFile(
  modelId: string,
  filename: string,
  cacheDir: string,
  opts?: { timeoutMs?: number; maxBytes?: number; inactivityMs?: number },
): Promise<string> {
  // Fast-path validation (throws synchronously via rejected promise before map lookup)
  validateInput(modelId, filename);

  const slug = slugify(modelId);
  const modelDir = join(cacheDir, slug);
  const finalPath = join(modelDir, filename);

  // FIX-4: cache hit only valid when file is non-empty
  if (isCacheValid(finalPath)) {
    return finalPath;
  }

  // CRITICAL-1 fix: deduplicate concurrent in-process downloads for the same file
  const existing = inflight.get(finalPath);
  if (existing) return existing;

  let promise: Promise<string>;
  promise = downloadToCache(modelId, filename, cacheDir, opts).finally(() => {
    if (inflight.get(finalPath) === promise) inflight.delete(finalPath);
  });

  inflight.set(finalPath, promise);
  return promise;
}
