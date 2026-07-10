import { execFile } from "node:child_process";
import { join } from "node:path";
import type { TextMatch } from "../../types.js";
import { MAX_LINE_CHARS, RG_EXCLUDE_DIRS, RIPGREP_TIMEOUT_MS } from "./constants.js";

interface RipgrepOptions {
  regex?: boolean;
  filePattern?: string | undefined;
  maxResults: number;
  contextLines: number;
  candidateFiles?: readonly string[] | undefined;
  signal?: AbortSignal | undefined;
}

let ripgrepAvailability: Promise<boolean> | null = null;

function detectRipgrep(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("rg", ["--version"], { encoding: "utf-8", timeout: 2000 }, (error) => {
      resolve(error === null);
    });
  });
}

export function hasRipgrep(): Promise<boolean> {
  ripgrepAvailability ??= detectRipgrep();
  return ripgrepAvailability;
}

function buildRipgrepArgs(root: string, query: string, options: RipgrepOptions): string[] {
  const args = [
    "--json",
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

function executeRipgrep(args: string[], signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("rg", args, {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: RIPGREP_TIMEOUT_MS,
      signal,
    }, (error, stdout) => {
      if (!error) return resolve(stdout);
      const exitCode = (error as Error & { code?: number | string }).code;
      if (exitCode === 1 || exitCode === "1") return resolve("");
      reject(error);
    });
  });
}

function relativePath(absolutePath: string, rootPrefix: string): string {
  return absolutePath.startsWith(rootPrefix)
    ? absolutePath.slice(rootPrefix.length)
    : absolutePath;
}

interface ParsedRipgrepLine {
  path: string;
  line: number;
  content: string;
  isMatch: boolean;
}

interface RipgrepJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

function stripLineEnding(content: string): string {
  return content.replace(/\r?\n$/, "");
}

function parseJsonEvent(rawLine: string, rootPrefix: string): ParsedRipgrepLine | null {
  let event: RipgrepJsonEvent;
  try {
    event = JSON.parse(rawLine) as RipgrepJsonEvent;
  } catch {
    return null;
  }
  if (event.type !== "match" && event.type !== "context") return null;
  const path = event.data?.path?.text;
  const line = event.data?.line_number;
  const content = event.data?.lines?.text;
  if (!path || line === undefined || content === undefined) return null;
  return {
    path: relativePath(path, rootPrefix),
    line,
    content: stripLineEnding(content),
    isMatch: event.type === "match",
  };
}

function buildContextMatch(
  parsedLines: ParsedRipgrepLine[],
  matchIndex: number,
  contextLines: number,
): TextMatch {
  const matchedLine = parsedLines[matchIndex]!;
  const contextBefore = parsedLines
    .slice(0, matchIndex)
    .filter((line) => !line.isMatch
      && line.path === matchedLine.path
      && line.line >= matchedLine.line - contextLines)
    .map((line) => line.content);
  const contextAfter = parsedLines
    .slice(matchIndex + 1)
    .filter((line) => !line.isMatch
      && line.path === matchedLine.path
      && line.line <= matchedLine.line + contextLines)
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

function parseRipgrepOutput(
  stdout: string,
  rootPrefix: string,
  maxResults: number,
  contextLines: number,
): TextMatch[] {
  const matches: TextMatch[] = [];
  const parsedLines = stdout.split("\n")
    .filter(Boolean)
    .map((line) => parseJsonEvent(line, rootPrefix))
    .filter((line): line is ParsedRipgrepLine => line !== null);
  for (let index = 0; index < parsedLines.length; index++) {
    if (matches.length >= maxResults) break;
    if (parsedLines[index]!.isMatch) {
      matches.push(buildContextMatch(parsedLines, index, contextLines));
    }
  }
  return matches;
}

export async function searchWithRipgrep(
  root: string,
  query: string,
  options: RipgrepOptions,
): Promise<TextMatch[]> {
  const stdout = await executeRipgrep(buildRipgrepArgs(root, query, options), options.signal);
  const rootPrefix = root.endsWith("/") ? root : `${root}/`;
  return parseRipgrepOutput(stdout, rootPrefix, options.maxResults, options.contextLines);
}
