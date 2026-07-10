import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { TextMatch } from "../../types.js";
import { MAX_LINE_CHARS, RG_EXCLUDE_DIRS, SEARCH_TIMEOUT_MS } from "./constants.js";

interface RipgrepOptions {
  regex?: boolean;
  filePattern?: string | undefined;
  maxResults: number;
  contextLines: number;
  candidateFiles?: readonly string[] | undefined;
}

let ripgrepAvailable: boolean | null = null;

export function hasRipgrep(): boolean {
  if (ripgrepAvailable !== null) return ripgrepAvailable;
  try {
    execFileSync("rg", ["--version"], { stdio: "pipe", timeout: 2000 });
    ripgrepAvailable = true;
  } catch {
    ripgrepAvailable = false;
  }
  return ripgrepAvailable;
}

function buildRipgrepArgs(root: string, query: string, options: RipgrepOptions): string[] {
  const args = [
    "-n",
    "--no-heading",
    "--max-columns", String(MAX_LINE_CHARS),
    "--max-columns-preview",
    "--max-count", String(Math.min(options.maxResults * 2, 5000)),
  ];
  if (!options.regex) args.push("-F");
  if (options.contextLines > 0) args.push("-C", String(options.contextLines));
  if (options.filePattern) args.push("--glob", options.filePattern);
  if (!options.candidateFiles || options.candidateFiles.length === 0) {
    for (const directory of RG_EXCLUDE_DIRS) args.push("--glob", `!${directory}`);
  } else {
    args.push("--with-filename");
  }
  args.push("--", query);
  if (options.candidateFiles && options.candidateFiles.length > 0) {
    for (const relativePath of options.candidateFiles) args.push(join(root, relativePath));
  } else {
    args.push(root);
  }
  return args;
}

function executeRipgrep(args: string[]): string {
  try {
    return execFileSync("rg", args, {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: SEARCH_TIMEOUT_MS,
    });
  } catch (error: unknown) {
    if (!error || typeof error !== "object" || !("status" in error)) return "";
    if ((error as { status: number }).status === 1) return "";
    if ("stdout" in error && typeof (error as { stdout: unknown }).stdout === "string") {
      return (error as { stdout: string }).stdout;
    }
    return "";
  }
}

function relativePath(absolutePath: string, rootPrefix: string): string {
  return absolutePath.startsWith(rootPrefix)
    ? absolutePath.slice(rootPrefix.length)
    : absolutePath;
}

function parseFlatMatches(
  blocks: string[],
  rootPrefix: string,
  maxResults: number,
): TextMatch[] {
  const matches: TextMatch[] = [];
  for (const block of blocks) {
    if (matches.length >= maxResults) break;
    for (const rawLine of block.split("\n").filter(Boolean)) {
      if (matches.length >= maxResults) break;
      const parsed = rawLine.match(/^(.+?):(\d+):(.*)/);
      if (!parsed?.[1] || !parsed[2] || parsed[3] === undefined) continue;
      matches.push({
        file: relativePath(parsed[1], rootPrefix),
        line: Number.parseInt(parsed[2], 10),
        content: parsed[3],
      });
    }
  }
  return matches;
}

interface ParsedRipgrepLine {
  path: string;
  line: number;
  content: string;
  isMatch: boolean;
}

function parseMatchedLine(rawLine: string, rootPrefix: string): ParsedRipgrepLine | null {
  const matchLine = rawLine.match(/^(.+?):(\d+):(.*)/);
  if (matchLine?.[1] && matchLine[2] && matchLine[3] !== undefined) {
    return {
      path: relativePath(matchLine[1], rootPrefix),
      line: Number.parseInt(matchLine[2], 10),
      content: matchLine[3],
      isMatch: true,
    };
  }
  return null;
}

function parseSurroundingLine(rawLine: string, rootPrefix: string): ParsedRipgrepLine | null {
  const contextLine = rawLine.match(/^(.+?)-(\d+)-(.*)/);
  if (!contextLine?.[1] || !contextLine[2] || contextLine[3] === undefined) return null;
  return {
    path: relativePath(contextLine[1], rootPrefix),
    line: Number.parseInt(contextLine[2], 10),
    content: contextLine[3],
    isMatch: false,
  };
}

function parseContextLine(rawLine: string, rootPrefix: string): ParsedRipgrepLine | null {
  return parseMatchedLine(rawLine, rootPrefix) ?? parseSurroundingLine(rawLine, rootPrefix);
}

function buildContextMatch(
  parsedLines: ParsedRipgrepLine[],
  matchIndex: number,
  contextLines: number,
): TextMatch {
  const matchedLine = parsedLines[matchIndex]!;
  const contextBefore = parsedLines
    .slice(Math.max(0, matchIndex - contextLines), matchIndex)
    .filter((line) => !line.isMatch)
    .map((line) => line.content);
  const contextAfter = parsedLines
    .slice(matchIndex + 1, matchIndex + contextLines + 1)
    .filter((line) => !line.isMatch)
    .map((line) => line.content);
  const match: TextMatch = {
    file: matchedLine.path,
    line: matchedLine.line,
    content: matchedLine.content,
  };
  if (contextBefore.length > 0) match.context_before = contextBefore;
  if (contextAfter.length > 0) match.context_after = contextAfter;
  return match;
}

function parseRipgrepContextBlocks(
  stdout: string,
  rootPrefix: string,
  maxResults: number,
  contextLines: number,
): TextMatch[] {
  const matches: TextMatch[] = [];
  for (const block of stdout.split(/^--$/m)) {
    if (matches.length >= maxResults) break;
    const parsedLines = block.split("\n")
      .filter(Boolean)
      .map((line) => parseContextLine(line, rootPrefix))
      .filter((line): line is ParsedRipgrepLine => line !== null);
    for (let index = 0; index < parsedLines.length; index++) {
      if (matches.length >= maxResults) break;
      if (parsedLines[index]!.isMatch) {
        matches.push(buildContextMatch(parsedLines, index, contextLines));
      }
    }
  }
  return matches;
}

export function searchWithRipgrep(
  root: string,
  query: string,
  options: RipgrepOptions,
): TextMatch[] {
  const stdout = executeRipgrep(buildRipgrepArgs(root, query, options));
  const rootPrefix = root.endsWith("/") ? root : `${root}/`;
  const blocks = options.contextLines > 0 ? stdout.split(/^--$/m) : [stdout];
  const matches = parseFlatMatches(blocks, rootPrefix, options.maxResults);
  return options.contextLines > 0 && blocks.length > 1
    ? parseRipgrepContextBlocks(stdout, rootPrefix, options.maxResults, options.contextLines)
    : matches;
}
