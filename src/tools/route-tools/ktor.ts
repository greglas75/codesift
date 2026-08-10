import type { CodeIndex } from "../../types.js";
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
  index: CodeIndex,
  file: string,
  line: number,
  method: string,
  methodPath: string,
): RouteHandler {
  const symbol = index.symbols.find(
    (candidate) =>
      candidate.file === file &&
      candidate.start_line <= line &&
      candidate.end_line >= line,
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

function scanKtorFile(
  index: CodeIndex,
  file: string,
  source: string,
  searchPath: string,
): RouteHandler[] {
  if (!/\b(routing|route)\s*[({]/.test(source)) return [];

  const handlers: RouteHandler[] = [];
  const state: ScopeState = { prefixes: [], braceDepth: 0 };
  for (const [lineIndex, line] of source.split("\n").entries()) {
    updateScopes(line, state);
    const prefix = state.prefixes.map((scope) => scope.prefix).join("/");
    for (const match of methodMatches(line)) {
      const fullPath = `${prefix}/${match.path}`.replace(/\/+/g, "/");
      if (matchPath(fullPath, searchPath)) {
        handlers.push(ktorHandler(index, file, lineIndex + 1, match.method, match.path));
      }
    }
  }
  return handlers;
}

/** Find Ktor handlers in routing DSL blocks, including nested route prefixes. */
export async function findKtorHandlers(
  index: CodeIndex,
  searchPath: string,
): Promise<RouteHandler[]> {
  const files = await readIndexedFiles(index, (path) => /\.kts?$/.test(path));
  return files.flatMap(({ path, source }) => scanKtorFile(index, path, source, searchPath));
}
