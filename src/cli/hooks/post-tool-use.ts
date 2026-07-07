import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, posix as pathPosix, relative } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { CODE_EXTENSIONS } from "./shared.js";
import { parseHookInput, readRawInput } from "./input.js";
import { findRepoRoot, logWikiEvent, positiveIntEnv, WIKI_MANIFEST_REL } from "./wiki.js";

const POSTINDEX_DEBOUNCE_MS = 2000;

function postindexDebouncePath(): string {
  const dataDir = process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
  return join(dataDir, "hook-debounce.json");
}

function shouldDebouncePostindex(filePath: string, now: number): boolean {
  try {
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
