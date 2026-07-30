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
export function detectProjectLanguagesSync(root: string): ProjectLanguages {
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
