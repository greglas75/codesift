import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstallRulesResult, SetupOptions } from "./types.js";
import { ensureDir, resolvePackageFile, sha256 } from "./fs.js";

const RULES_FILES: Record<string, { source: string; targetDir: string; targetFile: string }> = {
  claude: { source: "rules/codesift.md", targetDir: ".claude/rules", targetFile: "codesift.md" },
  cursor: { source: "rules/codesift.mdc", targetDir: ".cursor/rules", targetFile: "codesift.mdc" },
};

const APPEND_MODE_PLATFORMS: Record<string, { source: string; targetFile: string }> = {
  codex: { source: "rules/codex.md", targetFile: "AGENTS.md" },
  gemini: { source: "rules/gemini.md", targetFile: "GEMINI.md" },
};

const DELIMITER_START = "<!-- codesift-rules-start -->";
const DELIMITER_END = "<!-- codesift-rules-end -->";
const HEADER_REGEX = /^<!-- codesift-rules v([\d.]+) hash:(\w+) -->/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
}

const codeMarker = String.fromCharCode(96);
const CLAUDE_MD_BLOCK = [
  "## CodeSift MCP — code intelligence for this machine",
  "",
  "CodeSift MCP is installed (" + codeMarker + "mcp__codesift__*" + codeMarker + " tools).",
  "",
  '**If CodeSift tools appear in "deferred tools" list:** call this FIRST to load schemas:',
  codeMarker + 'ToolSearch(query="select:mcp__codesift__search_text,mcp__codesift__get_file_tree,mcp__codesift__search_symbols,mcp__codesift__get_symbol,mcp__codesift__plan_turn,mcp__codesift__index_status")' + codeMarker,
  "",
  "When working with code:",
  "- **Use CodeSift tools as default for code search and navigation** — they query a pre-built index (BM25 + tree-sitter symbols + semantic) and return ranked, deduplicated results far cheaper than reading files.",
  "- " + codeMarker + "search_text" + codeMarker + " instead of Grep for code search",
  "- " + codeMarker + "get_file_tree" + codeMarker + " instead of Glob for finding files",
  "- " + codeMarker + "search_symbols" + codeMarker + " / " + codeMarker + "get_symbol" + codeMarker + " for finding functions/classes",
  "- " + codeMarker + "plan_turn(query=...)" + codeMarker + " when you don't know which tool fits",
  "- The " + codeMarker + "repo" + codeMarker + " parameter auto-resolves from CWD — no need to list_repos first",
  "",
  "Full rules: " + codeMarker + "~/.claude/rules/codesift.md" + codeMarker + ". Detailed tool catalog via " + codeMarker + "discover_tools" + codeMarker + ".",
].join("\n");

function blockPattern(): RegExp {
  return new RegExp(
    escapeRegex(DELIMITER_START) + "[\\s\\S]*?" + escapeRegex(DELIMITER_END),
  );
}

export async function installGlobalClaudeMd(homeDir: string): Promise<InstallRulesResult> {
  const targetPath = join(homeDir, ".claude", "CLAUDE.md");
  const block = DELIMITER_START + "\n" + CLAUDE_MD_BLOCK + "\n" + DELIMITER_END;

  try {
    if (existsSync(targetPath)) {
      const existing = await readFile(targetPath, "utf-8");
      if (existing.includes(DELIMITER_START) && existing.includes(DELIMITER_END)) {
        const pattern = blockPattern();
        const match = existing.match(pattern);
        if (match?.[0] === block) return { path: targetPath, action: "skipped" };

        await writeFile(targetPath, existing.replace(pattern, block), "utf-8");
        return { path: targetPath, action: "updated" };
      }
      await writeFile(targetPath, existing.trimEnd() + "\n\n" + block + "\n", "utf-8");
      return { path: targetPath, action: "updated" };
    }

    await ensureDir(join(homeDir, ".claude"));
    await writeFile(targetPath, block + "\n", "utf-8");
    return { path: targetPath, action: "created" };
  } catch (err: unknown) {
    return {
      path: targetPath,
      action: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function installRulesAppendMode(
  platform: string,
  _options?: SetupOptions,
): Promise<InstallRulesResult> {
  const config = APPEND_MODE_PLATFORMS[platform];
  if (!config) {
    return { path: "", action: "error", error: "No append config for " + platform };
  }
  const targetPath = join(process.cwd(), config.targetFile);

  try {
    const sourcePath = resolvePackageFile(config.source);
    const sourceContent = (await readFile(sourcePath, "utf-8")).trimEnd();
    const block = DELIMITER_START + "\n" + sourceContent + "\n" + DELIMITER_END;

    if (existsSync(targetPath)) {
      const existing = await readFile(targetPath, "utf-8");
      if (existing.includes(DELIMITER_START) && existing.includes(DELIMITER_END)) {
        const pattern = blockPattern();
        const match = existing.match(pattern);
        if (match?.[0] === block) return { path: targetPath, action: "skipped" };

        await writeFile(targetPath, existing.replace(pattern, block), "utf-8");
        return { path: targetPath, action: "updated" };
      }
      await writeFile(targetPath, existing.trimEnd() + "\n\n" + block + "\n", "utf-8");
      return { path: targetPath, action: "updated" };
    }

    await writeFile(targetPath, block + "\n", "utf-8");
    return { path: targetPath, action: "created" };
  } catch (err: unknown) {
    return {
      path: targetPath,
      action: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function installRules(
  platform: string,
  homeDir: string,
  options?: SetupOptions,
): Promise<InstallRulesResult> {
  if (APPEND_MODE_PLATFORMS[platform]) {
    return installRulesAppendMode(platform, options);
  }

  const rulesConfig = RULES_FILES[platform];
  if (!rulesConfig) return { path: "", action: "skipped" };

  const targetPath = join(homeDir, rulesConfig.targetDir, rulesConfig.targetFile);
  try {
    const sourcePath = resolvePackageFile(rulesConfig.source);
    const sourceContent = await readFile(sourcePath, "utf-8");
    const pkg: unknown = JSON.parse(await readFile(resolvePackageFile("package.json"), "utf-8"));
    const version =
      typeof pkg === "object" && pkg !== null && "version" in pkg
        ? String((pkg as Record<string, unknown>)["version"])
        : "unknown";
    const sourceBody = sourceContent.replace(HEADER_REGEX, "").trimStart();
    const sourceHash = sha256(sourceBody);
    const newContent =
      "<!-- codesift-rules v" + version + " hash:" + sourceHash + " -->\n" + sourceBody;

    if (existsSync(targetPath)) {
      const existingContent = await readFile(targetPath, "utf-8");
      const match = HEADER_REGEX.exec(existingContent.split("\n")[0] ?? "");
      if (match) {
        const existingBody = existingContent.replace(HEADER_REGEX, "").trimStart();
        if (sha256(existingBody) === sourceHash) {
          if (match[1] === version && match[2] === sourceHash) {
            return { path: targetPath, action: "skipped" };
          }
          await writeFile(targetPath, newContent, "utf-8");
          return { path: targetPath, action: "updated" };
        }
      }

      if (!options?.force) {
        return {
          path: targetPath,
          action: "skipped",
          warning: "Rules file has been modified by user. Use --force to overwrite.",
        };
      }
      await writeFile(targetPath, newContent, "utf-8");
      return { path: targetPath, action: "force-updated" };
    }

    await ensureDir(join(homeDir, rulesConfig.targetDir));
    await writeFile(targetPath, newContent, "utf-8");
    return { path: targetPath, action: "created" };
  } catch (err: unknown) {
    return {
      path: targetPath,
      action: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
