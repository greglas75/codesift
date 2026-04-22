import { readFile, writeFile, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseSentinelBlocks } from "./journal-sentinel.js";

const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertSafeSlug(slug: string): void {
  if (!SAFE_SLUG_RE.test(slug)) {
    throw new Error(`Unsafe journal slug "${slug}" (must match ${SAFE_SLUG_RE.source})`);
  }
}

export interface CheckpointState { startedAt: string; completed: string[]; costUsd: number }

export class BlockChangedError extends Error {
  readonly blockKind: string;
  constructor(kind: string) {
    super(`Block ${kind} changed since read`);
    this.name = "BlockChangedError"; this.blockKind = kind;
  }
}

export class BudgetExceededError extends Error {
  readonly file: string; readonly sizeBytes: number; readonly limit: number;
  constructor(file: string, sizeBytes: number, limit: number) {
    super(`${file} is ${sizeBytes} bytes, exceeds ${limit}`);
    this.name = "BudgetExceededError";
    this.file = file; this.sizeBytes = sizeBytes; this.limit = limit;
  }
}

export const BUDGETS: Readonly<Record<string, number>> = {
  "rollup.md": 12_000,
  "overview.md": 6_000,
};

export function assertBlockUnchanged(fileContent: string, blockKind: string, preHash: string): void {
  const block = parseSentinelBlocks(fileContent).find((b) => b.kind === blockKind);
  if (!block || block.hash !== preHash) throw new BlockChangedError(blockKind);
}

export async function acquireLock(lockPath: string): Promise<void> {
  await writeFile(lockPath, String(process.pid), { flag: "wx" });
}

export async function releaseLock(lockPath: string): Promise<void> {
  try { await unlink(lockPath); } catch { /* best-effort */ }
}

export async function readCheckpoint(path: string): Promise<CheckpointState | null> {
  try { return JSON.parse(await readFile(path, "utf-8")) as CheckpointState; }
  catch { return null; }
}

export async function writeCheckpoint(path: string, state: CheckpointState): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

export function enforceBudgets(files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const limit = BUDGETS[name];
    if (limit === undefined) continue;
    const size = Buffer.byteLength(content, "utf-8");
    if (size > limit) throw new BudgetExceededError(name, size, limit);
  }
}

export async function anyFileHasTodo(dir: string, files: string[]): Promise<boolean> {
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    try { if ((await readFile(join(dir, f), "utf-8")).includes("TODO:")) return true; }
    catch { /* ignore */ }
  }
  return false;
}

export async function readPhaseBlockHash(filePath: string, kind: string): Promise<string | undefined> {
  try {
    const content = await readFile(filePath, "utf-8");
    return parseSentinelBlocks(content).find((b) => b.kind === kind)?.hash;
  } catch { return undefined; }
}

/** Atomic write with TOCTOU guard: re-read + hash-check before tmp→rename. */
export async function writePhaseAtomic(
  filePath: string, content: string, preHash: string | undefined, force: boolean,
): Promise<void> {
  if (preHash !== undefined) {
    let latest = "";
    try { latest = await readFile(filePath, "utf-8"); } catch { /* new file */ }
    try { assertBlockUnchanged(latest, "phase-summary", preHash); }
    catch (err) {
      if (!(err instanceof BlockChangedError)) throw err;
      if (!force) throw err;
      console.warn("WARN journal: forced overwrite");
    }
  }
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { encoding: "utf-8", flag: "wx" });
  await rename(tmp, filePath);
}
