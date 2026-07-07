import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, posix as pathPosix, relative } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CODE_EXTENSIONS } from "./shared.js";
import { parseHookInput, readRawInput } from "./input.js";
import { findRepoRoot, logWikiEvent, positiveIntEnv, WIKI_MANIFEST_REL } from "./wiki.js";

const POSTINDEX_DEBOUNCE_MS = 2000;
const POSTINDEX_LOCK_STALE_MS = 30_000;
const POSTINDEX_LOCK_FORCE_STALE_MS = 5 * 60_000;
const POSTINDEX_LOCK_RETRY_MS = 150;
const POSTINDEX_LOCK_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function postindexDebouncePath(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, "hook-debounce.json");
}

function postindexLockPath(): string {
  return `${postindexDebouncePath()}.lock`;
}

function postindexGcLockPath(): string {
  return `${postindexLockPath()}.gc`;
}

function removeStalePostindexGcLock(now: number): void {
  const gcLockPath = postindexGcLockPath();
  try {
    const lockStat = statSync(gcLockPath);
    if (now - lockStat.mtimeMs > POSTINDEX_LOCK_STALE_MS) {
      rmSync(gcLockPath, { recursive: true, force: true });
    }
  } catch {
    // Missing GC lock is the normal path.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : null;
    return code === "EPERM";
  }
}

function writePostindexLockMetadata(lockPath: string, now: number, token: string): void {
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, created_at: now, token }));
}

function createPostindexLock(lockPath: string, now: number): string {
  removeStalePostindexGcLock(now);
  if (existsSync(postindexGcLockPath())) {
    throw new Error("postindex lock GC in progress");
  }
  const token = randomUUID();
  mkdirSync(lockPath, { recursive: false });
  try {
    writePostindexLockMetadata(lockPath, now, token);
    return token;
  } catch (error) {
    rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
}

function tryCreatePostindexLock(lockPath: string, now: number): string | null {
  try {
    return createPostindexLock(lockPath, now);
  } catch {
    return null;
  }
}

function retryCreatePostindexLock(lockPath: string): string | null {
  const deadline = Date.now() + POSTINDEX_LOCK_RETRY_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    const waitMs = Math.min(25, 5 + attempt * 5);
    Atomics.wait(POSTINDEX_LOCK_RETRY_BUFFER, 0, 0, waitMs);
    const token = tryCreatePostindexLock(lockPath, Date.now());
    if (token) return token;
    attempt += 1;
  }
  return null;
}

function releasePostindexLock(lockPath: string, token: string): void {
  try {
    const raw = readFileSync(join(lockPath, "owner.json"), "utf-8");
    const owner = JSON.parse(raw) as { pid?: unknown; token?: unknown };
    if (owner.pid !== process.pid || owner.token !== token) {
      return;
    }
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // best-effort lock cleanup
  }
}

function removeStalePostindexLock(lockPath: string, now: number): void {
  let gcLockAcquired = false;
  const gcLockPath = postindexGcLockPath();
  const ownerPath = join(lockPath, "owner.json");
  try {
    removeStalePostindexGcLock(now);
    mkdirSync(gcLockPath, { recursive: false });
    gcLockAcquired = true;

    const lockStat = statSync(lockPath);
    if (now - lockStat.mtimeMs <= POSTINDEX_LOCK_STALE_MS) {
      return;
    }

    let observedOwnerRaw: string | null = null;
    try {
      const raw = readFileSync(ownerPath, "utf-8");
      observedOwnerRaw = raw;
      const owner = JSON.parse(raw) as { pid?: unknown; created_at?: unknown };
      const createdAt = typeof owner.created_at === "number" ? owner.created_at : lockStat.mtimeMs;
      if (typeof owner.pid === "number" && isProcessAlive(owner.pid) && now - createdAt <= POSTINDEX_LOCK_FORCE_STALE_MS) {
        return;
      }
    } catch {
      // Legacy locks had no metadata; stale legacy locks are safe to remove.
    }

    try {
      if (observedOwnerRaw === null) {
        if (existsSync(ownerPath)) return;
      } else if (readFileSync(ownerPath, "utf-8") !== observedOwnerRaw) {
        return;
      }
    } catch {
      if (observedOwnerRaw !== null) return;
    }

    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Missing or unreadable lock metadata is handled by the mkdir lock attempt.
  } finally {
    if (gcLockAcquired) {
      try {
        rmSync(gcLockPath, { recursive: true, force: true });
      } catch {
        // best-effort GC lock cleanup
      }
    }
  }
}

function shouldDebouncePostindex(filePath: string, now: number): boolean {
  let lockAcquired = false;
  let lockToken: string | null = null;
  try {
    const lockPath = postindexLockPath();
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      lockToken = tryCreatePostindexLock(lockPath, now);
      if (!lockToken) throw new Error("postindex lock busy");
      lockAcquired = true;
    } catch {
      removeStalePostindexLock(lockPath, now);
      lockToken = tryCreatePostindexLock(lockPath, Date.now()) ?? retryCreatePostindexLock(lockPath);
      if (!lockToken) {
        return false;
      }
      lockAcquired = true;
    }

    const path = postindexDebouncePath();
    let state: Record<string, number> = {};
    if (existsSync(path)) {
      try {
        state = JSON.parse(readFileSync(path, "utf-8")) as Record<string, number>;
      } catch {
        state = {};
      }
    }
    const last = state[filePath];
    if (typeof last === "number" && now - last < POSTINDEX_DEBOUNCE_MS) {
      return true;
    }
    const pruned: Record<string, number> = { [filePath]: now };
    for (const [k, v] of Object.entries(state)) {
      if (k !== filePath && typeof v === "number" && now - v < 60_000) {
        pruned[k] = v;
      }
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(pruned));
    } catch {
      // Disk error is non-fatal for hook indexing.
    }
    return false;
  } catch {
    return false;
  } finally {
    if (lockAcquired && lockToken) {
      releasePostindexLock(postindexLockPath(), lockToken);
    }
  }
}

function wikiRegenDebounceMs(): number {
  const raw = process.env["CODESIFT_WIKI_REGEN_DEBOUNCE_MIN"];
  const min = raw ? parseInt(raw, 10) : NaN;
  return (Number.isNaN(min) || min <= 0 ? 24 * 60 : min) * 60 * 1000;
}

const WIKI_REGEN_DEBOUNCE_MS = wikiRegenDebounceMs();
const WIKI_REGEN_DEFAULT_MAX_FILES = 5000;

function wikiRegenMaxFiles(): number {
  return positiveIntEnv("CODESIFT_WIKI_AUTO_REGEN_MAX_FILES", WIKI_REGEN_DEFAULT_MAX_FILES);
}

function wikiRegenStatePath(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, "wiki-regen-debounce.json");
}

function shouldDebounceWikiRegen(repoRoot: string, now: number): boolean {
  try {
    const path = wikiRegenStatePath();
    let state: Record<string, number> = {};
    if (existsSync(path)) {
      try {
        state = JSON.parse(readFileSync(path, "utf-8")) as Record<string, number>;
      } catch {
        state = {};
      }
    }
    const last = state[repoRoot];
    if (typeof last === "number" && now - last < WIKI_REGEN_DEBOUNCE_MS) return true;
    const pruned: Record<string, number> = { [repoRoot]: now };
    for (const [k, v] of Object.entries(state)) {
      if (k !== repoRoot && typeof v === "number" && now - v < 60 * 60_000) pruned[k] = v;
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(pruned));
    } catch {
      // best-effort state write
    }
    return false;
  } catch {
    return false;
  }
}

function maybeRegenerateWiki(filePath: string, now: number, sessionId?: string | null): void {
  try {
    const optIn = process.env.CODESIFT_WIKI_AUTO_REGEN;
    if (optIn !== "1" && optIn !== "true") return;

    const repoRoot = findRepoRoot(filePath);
    if (!repoRoot) return;

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(join(repoRoot, WIKI_MANIFEST_REL), "utf-8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const fileMap = manifest["file_to_community"];
    const knownFiles = fileMap && typeof fileMap === "object" ? (fileMap as Record<string, unknown>) : null;

    if (knownFiles && Object.keys(knownFiles).length > wikiRegenMaxFiles()) return;

    if (knownFiles) {
      const rel = pathPosix.normalize(relative(repoRoot, filePath).split("\\").join("/"));
      if (rel in knownFiles) return;
    }

    if (shouldDebounceWikiRegen(repoRoot, now)) return;

    const cliEntry = process.argv[1];
    if (!cliEntry) return;
    const child = spawn(process.execPath, [cliEntry, "wiki-generate", "--no-lens"], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      // never surface background spawn failures from a hook
    });
    child.unref();
    logWikiEvent("wiki_auto_regen", repoRoot, { trigger: "new-file", file: relative(repoRoot, filePath) }, 0, sessionId);
  } catch {
    // auto-regen is best-effort
  }
}

export async function handlePostindexFile(): Promise<void> {
  try {
    const raw = readRawInput();
    if (!raw) {
      process.exit(0);
      return;
    }

    const { filePath } = parseHookInput(raw);
    if (!filePath) {
      process.exit(0);
      return;
    }

    const ext = extname(filePath).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) {
      process.exit(0);
      return;
    }

    if (shouldDebouncePostindex(filePath, Date.now())) {
      process.exit(0);
      return;
    }

    try {
      const { indexFile } = await import("../../tools/index-tools.js");
      await indexFile(filePath);
    } catch {
      // fire-and-forget: never block the agent on hook errors
    }

    maybeRegenerateWiki(filePath, Date.now(), parseHookInput(raw).sessionId);

    process.exit(0);
  } catch {
    process.exit(0);
  }
}
