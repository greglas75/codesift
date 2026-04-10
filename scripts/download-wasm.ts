/**
 * Download tree-sitter WASM grammar files for web-tree-sitter.
 *
 * Installs each grammar's npm package into a temp directory, copies the
 * `.wasm` file to `src/parser/languages/`, then cleans up.
 *
 * Usage:
 *   npx tsx scripts/download-wasm.ts          # skip existing files
 *   npx tsx scripts/download-wasm.ts --force   # re-download all
 */

import { execSync } from "node:child_process";
import {
  mkdirSync,
  copyFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const targetDir = join(projectRoot, "src", "parser", "languages");

// ---------------------------------------------------------------------------
// Grammar definitions
// ---------------------------------------------------------------------------

interface GrammarDef {
  /** npm package name */
  pkg: string;
  /**
   * Relative paths (from package root inside node_modules) to the .wasm files
   * to copy. The last segment of each path is used as the output filename.
   */
  wasmPaths: string[];
}

const GRAMMARS: GrammarDef[] = [
  {
    pkg: "tree-sitter-typescript",
    wasmPaths: [
      "tree-sitter-typescript.wasm",
      "tree-sitter-tsx.wasm",
    ],
  },
  {
    pkg: "tree-sitter-javascript",
    wasmPaths: ["tree-sitter-javascript.wasm"],
  },
  {
    pkg: "tree-sitter-python",
    wasmPaths: ["tree-sitter-python.wasm"],
  },
  {
    pkg: "tree-sitter-go",
    wasmPaths: ["tree-sitter-go.wasm"],
  },
  {
    pkg: "tree-sitter-rust",
    wasmPaths: ["tree-sitter-rust.wasm"],
  },
  {
    pkg: "tree-sitter-java",
    wasmPaths: ["tree-sitter-java.wasm"],
  },
  {
    pkg: "tree-sitter-ruby",
    wasmPaths: ["tree-sitter-ruby.wasm"],
  },
  {
    // Pinned to 0.23.12 — ABI 14 compat with web-tree-sitter 0.24.x.
    // tree-sitter-php 0.24+ requires ABI 15 (web-tree-sitter 0.25+).
    pkg: "tree-sitter-php@0.23.12",
    wasmPaths: ["tree-sitter-php.wasm", "tree-sitter-php_only.wasm"],
  },
  {
    pkg: "tree-sitter-markdown",
    wasmPaths: ["tree-sitter-markdown.wasm"],
  },
  {
    pkg: "tree-sitter-css",
    wasmPaths: ["tree-sitter-css.wasm"],
  },
  {
    pkg: "tree-sitter-json",
    wasmPaths: ["tree-sitter-json.wasm"],
  },
  {
    pkg: "@tree-sitter-grammars/tree-sitter-kotlin",
    wasmPaths: ["tree-sitter-kotlin.wasm"],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const force = process.argv.includes("--force");

function log(msg: string): void {
  process.stdout.write(msg);
}

function logLine(msg: string): void {
  console.log(msg);
}

/**
 * Recursively search for a file by name inside a directory tree.
 * Returns the first match or undefined.
 */
function findFile(dir: string, fileName: string): string | undefined {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
    if (entry.isDirectory() && entry.name !== ".git") {
      const found = findFile(fullPath, fileName);
      if (found) return found;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logLine("tree-sitter WASM grammar downloader");
  logLine("====================================\n");

  // Ensure target directory exists
  mkdirSync(targetDir, { recursive: true });

  // Create temp working directory
  const tmpDir = mkdtempSync(join(tmpdir(), "tree-sitter-wasm-"));
  logLine(`Temp directory: ${tmpDir}\n`);

  const results: { name: string; status: "downloaded" | "skipped" | "failed"; error?: string }[] = [];

  try {
    for (const grammar of GRAMMARS) {
      const allExist =
        !force &&
        grammar.wasmPaths.every((wp) => {
          const outName = wp.split("/").pop()!;
          return existsSync(join(targetDir, outName));
        });

      if (allExist) {
        const names = grammar.wasmPaths.map((wp) => wp.split("/").pop()).join(", ");
        logLine(`Skipping ${grammar.pkg} (${names} already exists)`);
        for (const wp of grammar.wasmPaths) {
          results.push({ name: wp.split("/").pop()!, status: "skipped" });
        }
        continue;
      }

      log(`Downloading ${grammar.pkg}...`);

      try {
        // Install the package into temp dir
        execSync(`npm install --prefix "${tmpDir}" ${grammar.pkg}`, {
          stdio: "pipe",
          timeout: 120_000,
        });

        const pkgDir = join(tmpDir, "node_modules", grammar.pkg);

        for (const wasmRelPath of grammar.wasmPaths) {
          const outName = wasmRelPath.split("/").pop()!;

          // Try direct path first
          let srcPath = join(pkgDir, wasmRelPath);

          // If not found at the direct path, search recursively
          if (!existsSync(srcPath)) {
            const found = findFile(pkgDir, outName);
            if (found) {
              srcPath = found;
            }
          }

          // Also search the broader node_modules in case it's a transitive dep
          if (!existsSync(srcPath)) {
            const found = findFile(join(tmpDir, "node_modules"), outName);
            if (found) {
              srcPath = found;
            }
          }

          if (!existsSync(srcPath)) {
            logLine(` WARN: ${outName} not found in package`);
            results.push({
              name: outName,
              status: "failed",
              error: "WASM file not found in installed package",
            });
            continue;
          }

          copyFileSync(srcPath, join(targetDir, outName));
          results.push({ name: outName, status: "downloaded" });
        }

        logLine(" done");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logLine(` FAILED`);
        logLine(`  Error: ${message}`);
        for (const wp of grammar.wasmPaths) {
          results.push({
            name: wp.split("/").pop()!,
            status: "failed",
            error: message,
          });
        }
      }
    }
  } finally {
    // Clean up temp directory
    log("\nCleaning up temp directory...");
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      logLine(" done");
    } catch {
      logLine(` WARN: could not remove ${tmpDir}`);
    }
  }

  // Print summary
  logLine("\n====================================");
  logLine("Summary:\n");

  const downloaded = results.filter((r) => r.status === "downloaded");
  const skipped = results.filter((r) => r.status === "skipped");
  const failed = results.filter((r) => r.status === "failed");

  if (downloaded.length > 0) {
    logLine(`  Downloaded (${downloaded.length}):`);
    for (const r of downloaded) {
      logLine(`    ${r.name}`);
    }
  }

  if (skipped.length > 0) {
    logLine(`  Skipped (${skipped.length}):`);
    for (const r of skipped) {
      logLine(`    ${r.name}`);
    }
  }

  if (failed.length > 0) {
    logLine(`  Failed (${failed.length}):`);
    for (const r of failed) {
      logLine(`    ${r.name}: ${r.error}`);
    }
  }

  logLine(`\nTarget: ${targetDir}`);

  if (failed.length > 0) {
    logLine("\nSome grammars failed to download. You may need to build them manually.");
    logLine("See: https://github.com/nicolo-ribaudo/tree-sitter-wasm-pack");
    process.exit(1);
  }

  logLine("\nAll grammars ready.");
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
