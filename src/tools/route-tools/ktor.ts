import type { CodeSymbol } from "../../types.js";
import { asRouteIndex, type RouteIndexInput } from "./route-index.js";
import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import { readIndexedFiles } from "./file-sources.js";
import type { RouteHandler } from "./types.js";

const KTOR_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"];

interface RouteScope {
  prefix: string;
  braceDepth: number;
}

interface ScopeState {
  prefixes: RouteScope[];
  braceDepth: number;
}

function updateScopes(line: string, state: ScopeState): void {
  const route = /\broute\s*\(\s*["']([^"']+)["']\s*\)\s*\{/.exec(line);
  if (route) state.prefixes.push({ prefix: route[1]!, braceDepth: state.braceDepth });

  for (const character of line) {
    if (character === "{") {
      state.braceDepth++;
      continue;
    }
    if (character !== "}") continue;

    state.braceDepth--;
    let currentScope = state.prefixes.at(-1);
    while (currentScope && currentScope.braceDepth >= state.braceDepth) {
      state.prefixes.pop();
      currentScope = state.prefixes.at(-1);
    }
  }
}

function methodMatches(line: string): Array<{ method: string; path: string }> {
  const matches: Array<{ method: string; path: string }> = [];
  for (const method of KTOR_METHODS) {
    const pattern = new RegExp(`\\b${method}\\s*\\(\\s*["']([^"']+)["']\\s*\\)\\s*\\{`);
    const match = pattern.exec(line);
    if (match) matches.push({ method, path: match[1]! });
  }
  return matches;
}

function ktorHandler(
  fileSymbols: CodeSymbol[],
  file: string,
  line: number,
  method: string,
  methodPath: string,
): RouteHandler {
  const symbol = fileSymbols.find(
    (candidate) => candidate.start_line <= line && candidate.end_line >= line,
  );
  return {
    symbol: symbol
      ? stripSource(symbol)
      : {
          id: `${file}:${method}:${methodPath}`,
          name: `${method} ${methodPath}`,
          kind: "function",
          file,
          start_line: line,
          end_line: line,
        } as ReturnType<typeof stripSource>,
    file,
    method: method.toUpperCase(),
    framework: "ktor",
  };
}

interface KtorMatch {
  line: number;
  method: string;
  path: string;
}

function scanKtorFile(source: string, searchPath: string): KtorMatch[] {
  if (!/\b(routing|route)\s*[({]/.test(source)) return [];

  const matches: KtorMatch[] = [];
  const state: ScopeState = { prefixes: [], braceDepth: 0 };
  for (const [lineIndex, line] of source.split("\n").entries()) {
    updateScopes(line, state);
    const prefix = state.prefixes.map((scope) => scope.prefix).join("/");
    for (const match of methodMatches(line)) {
      const fullPath = `${prefix}/${match.path}`.replace(/\/+/g, "/");
      if (matchPath(fullPath, searchPath)) {
        matches.push({ line: lineIndex + 1, method: match.method, path: match.path });
      }
    }
  }
  return matches;
}

/** Find Ktor handlers in routing DSL blocks, including nested route prefixes. */
export async function findKtorHandlers(
  input: RouteIndexInput,
  searchPath: string,
): Promise<RouteHandler[]> {
  const index = asRouteIndex(input);
  const files = await readIndexedFiles(index, (path) => /\.kts?$/.test(path));
  const handlers: RouteHandler[] = [];
  for (const { path, source } of files) {
    const matches = scanKtorFile(source, searchPath);
    if (matches.length === 0) continue;
    // A file's symbols are read only when one of its routes matches.
    const fileSymbols = await index.inFiles([path], false);
    for (const match of matches) {
      handlers.push(ktorHandler(fileSymbols, path, match.line, match.method, match.path));
    }
  }
  return handlers;
}
