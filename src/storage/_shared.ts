import { writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write content to a file atomically using a write-rename strategy.
 * 1. Ensures the parent directory exists (mkdir -p).
 * 2. Writes content to a temporary file adjacent to the target.
 * 3. Renames the temp file to the target path (atomic on most filesystems).
 * 4. On error, removes the temp file before re-throwing.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string,
): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });

  // pid + random: Date.now() alone collides when two writers (parallel test
  // workers, concurrent MCP server instances) hit the same target in the same
  // millisecond — the loser's rename then fails with ENOENT.
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, targetPath);
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* cleanup best-effort */ }
    throw err;
  }
}
