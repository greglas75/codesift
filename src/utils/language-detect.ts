/**
 * Quick language detection for a project directory — runs BEFORE indexing.
 *
 * Used by registerTools() to gate language-specific tools behind language
 * presence: PHP tools only surface if the project has .php files, Python
 * tools only surface if the project has .py files, etc.
 *
 * Performance: fast file-tree walk with early-exit per language. Caps at
 * ~2000 files to avoid slow startup on huge monorepos.
 */
import { readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectLanguages {
  python: boolean;
  php: boolean;
  typescript: boolean;
  javascript: boolean;
  kotlin: boolean;
  go: boolean;
  rust: boolean;
  ruby: boolean;
}

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".next",
  ".nuxt",
  "vendor",        // PHP composer deps
  "site-packages", // inside .venv
  ".tox",
  "coverage",
  ".idea",
  ".vscode",
]);

const EXTENSION_MAP: Record<string, keyof ProjectLanguages> = {
  ".py": "python",
  ".php": "php",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
};

const MAX_FILES_SCANNED = 2000;

/**
 * Scan a directory for source file extensions, returning which languages
 * are present. Short-circuits once all tracked languages are found.
 */
export async function detectProjectLanguages(root: string): Promise<ProjectLanguages> {
  const found: ProjectLanguages = {
    python: false,
    php: false,
    typescript: false,
    javascript: false,
    kotlin: false,
    go: false,
    rust: false,
    ruby: false,
  };

  let filesScanned = 0;

  async function walk(dir: string): Promise<void> {
    if (filesScanned >= MAX_FILES_SCANNED) return;
    if (allDetected(found)) return;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (filesScanned >= MAX_FILES_SCANNED) return;
      if (allDetected(found)) return;

      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        filesScanned++;
        const dot = entry.name.lastIndexOf(".");
        if (dot === -1) continue;
        const ext = entry.name.slice(dot);
        const lang = EXTENSION_MAP[ext];
        if (lang) found[lang] = true;
      }
    }
  }

  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return found;
  } catch {
    return found;
  }

  await walk(root);
  return found;
}

function allDetected(found: ProjectLanguages): boolean {
  return found.python && found.php && found.typescript && found.javascript
    && found.kotlin && found.go && found.rust && found.ruby;
}

/**
 * Synchronous variant for use during server startup where top-level await
 * isn't convenient. Uses readdirSync. Caps at MAX_FILES_SCANNED.
 */
/**
 * Detected languages, per project root.
 *
 * The scan below is a synchronous recursive readdir bounded at MAX_FILES_SCANNED. It has one
 * caller — registerTools — and in the shared HTTP daemon a server is constructed PER REQUEST, so
 * an uncached scan ran on every single MCP call, `initialize` included. Warm that is tens of
 * milliseconds; on a directory the OS has never read it is seconds. Measured on a first connect to
 * an untouched tgm-survey-platform worktree: 8.7 s, 21.7 s and 51.9 s on three attempts, against
 * 0.1 s for the listTools that follows it — and a client whose initialize outlives its own timeout
 * spends its entire session with no CodeSift tools at all, which is what agents were reporting.
 *
 * A repository gains or loses a LANGUAGE very rarely, and the consequence of noticing late is a
 * tool surface that stays as it was for a few more minutes. That is not the same kind of staleness
 * as a wrong search result, so time is the right invalidator here.
 */
interface LanguageCacheEntry {
  value: ProjectLanguages;
  at: number;
}

const LANGUAGE_CACHE_TTL_MS = 10 * 60 * 1000;
/** Bounded because this machine has 858 registered repositories and the daemon outlives all of
 *  them; an unbounded map keyed by path is a slow leak, not a cache. */
const LANGUAGE_CACHE_MAX_ENTRIES = 256;
const languageCache = new Map<string, LanguageCacheEntry>();

/** Exported for tests: the cache is keyed by path and would otherwise leak between cases. */
export function resetLanguageDetectionCache(): void {
  languageCache.clear();
}

export function detectProjectLanguagesSync(root: string): ProjectLanguages {
  const cached = languageCache.get(root);
  if (cached && Date.now() - cached.at < LANGUAGE_CACHE_TTL_MS) {
    // Re-insert so the eviction below drops genuinely cold roots rather than merely old ones.
    languageCache.delete(root);
    languageCache.set(root, cached);
    return cached.value;
  }
  const detected = detectProjectLanguagesUncached(root);
  languageCache.set(root, { value: detected, at: Date.now() });
  if (languageCache.size > LANGUAGE_CACHE_MAX_ENTRIES) {
    const oldest = languageCache.keys().next();
    if (!oldest.done) languageCache.delete(oldest.value);
  }
  return detected;
}

function detectProjectLanguagesUncached(root: string): ProjectLanguages {
  const found: ProjectLanguages = {
    python: false,
    php: false,
    typescript: false,
    javascript: false,
    kotlin: false,
    go: false,
    rust: false,
    ruby: false,
  };

  // NOTE: this used to `require("node:fs")` here. The package is ESM, so that
  // threw ReferenceError on every call; registerTools caught it and fell into
  // its "on failure, enable everything" branch, which silently disabled ALL
  // requiresLanguage gating — every project looked like it contained every
  // language. Keep these as static imports.
  let filesScanned = 0;

  function walk(dir: string): void {
    if (filesScanned >= MAX_FILES_SCANNED) return;
    if (allDetected(found)) return;

    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (filesScanned >= MAX_FILES_SCANNED) return;
      if (allDetected(found)) return;

      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        filesScanned++;
        const dot = entry.name.lastIndexOf(".");
        if (dot === -1) continue;
        const ext = entry.name.slice(dot);
        const lang = EXTENSION_MAP[ext];
        if (lang) found[lang] = true;
      }
    }
  }

  try {
    if (!statSync(root).isDirectory()) return found;
  } catch {
    return found;
  }

  walk(root);
  return found;
}
