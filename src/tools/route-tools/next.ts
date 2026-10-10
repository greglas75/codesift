import type { CodeSymbol } from "../../types.js";
import { asRouteIndex, type RouteIndex, type RouteIndexInput } from "./route-index.js";
import { deriveUrlPath } from "../../utils/nextjs.js";
import { stripSource } from "../graph-tools.js";
import { matchPath } from "../route-shared.js";
import type { RouteHandler } from "./types.js";

function syntheticHandler(file: string, name: string): CodeSymbol {
  return {
    id: file,
    name,
    kind: "function",
    file,
    start_line: 1,
    end_line: 1,
  } as CodeSymbol;
}

async function appHandlersForFile(index: RouteIndex, file: string): Promise<RouteHandler[]> {
  const symbols = (await index.inFiles([file], false)).filter(
    // HEAD and OPTIONS are route exports like any other. Omitting them did not just lose the
    // method — a file exporting only HEAD fell into the `symbols.length === 0` branch below and
    // was reported as an un-methoded synthetic "route".
    (symbol) => /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(symbol.name),
  );
  if (symbols.length === 0) {
    return [{
      symbol: syntheticHandler(file, "route"),
      file,
      framework: "nextjs",
      router: "app",
    }];
  }
  return symbols.map((symbol) => ({
    symbol: stripSource(symbol),
    file: symbol.file,
    method: symbol.name,
    framework: "nextjs",
    router: "app",
  }));
}

/** Find Next.js App Router handlers whose file path defines the route. */
export async function findNextJSHandlers(input: RouteIndexInput, searchPath: string): Promise<RouteHandler[]> {
  const index = asRouteIndex(input);
  const handlers: RouteHandler[] = [];
  const normalizedSearch = searchPath.replace(/^\/|\/$/g, "");

  for (const file of index.files) {
    // `(.*?)/route.` required at least one segment between `app/` and the file, so the ROOT route
    // `app/route.ts` — a real and common Next.js route for `/` — could never match. The segment
    // group is now optional, and an absent group means the root path.
    const routeMatch = /app\/(?:(.*)\/)?route\.[jt]sx?$/.exec(file.path);
    if (!routeMatch) continue;
    const routePath = (routeMatch[1] ?? "").replace(/\([^)]+\)\/?/g, "");
    if (matchPath(routePath, normalizedSearch)) {
      handlers.push(...await appHandlersForFile(index, file.path));
    }
  }
  return handlers;
}
function hasNextProjectSignal(index: Pick<RouteIndex, "files">): boolean {
  return index.files.some((file) =>
    /^(src\/)?next\.config\.[mc]?[jt]sx?$/.test(file.path) ||
    /(^|\/)app\/.*\/(page|layout|route)\.[jt]sx?$/.test(file.path)
  );
}

async function pagesHandlerForFile(index: RouteIndex, file: string): Promise<RouteHandler> {
  const symbols = await index.inFiles([file], false);
  const symbol = symbols.find((candidate) =>
    candidate.name === "default" || candidate.name === "handler"
  ) ?? symbols.find((candidate) =>
    candidate.kind === "function" || candidate.kind === "variable"
  );

  return {
    symbol: symbol ? stripSource(symbol) : syntheticHandler(file, "handler"),
    file,
    framework: "nextjs",
    router: "pages",
  };
}

/** Find Next.js Pages Router API handlers while excluding Astro's src/pages convention. */
export async function findPagesRouterHandlers(input: RouteIndexInput, searchPath: string): Promise<RouteHandler[]> {
  const index = asRouteIndex(input);
  if (!hasNextProjectSignal(index)) return [];

  const normalizedSearch = searchPath.replace(/^\/|\/$/g, "");
  const handlers: RouteHandler[] = [];
  for (const file of index.files) {
    if (!/^(\.\/)?pages\/api\//.test(file.path)) continue;
    const normalizedRoute = deriveUrlPath(file.path, "pages").replace(/^\/|\/$/g, "");
    if (normalizedRoute === normalizedSearch) {
      handlers.push(await pagesHandlerForFile(index, file.path));
    }
  }
  return handlers;
}
