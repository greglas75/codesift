/**
 * NestJS guard, middleware, and decorator chain analysis.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import type { NestToolError } from "./nest-shared-tools.js";
import { extractNestConventions } from "./project-tools.js";

// ---------------------------------------------------------------------------
// B2: nest_guard_chain — types (implementation in Task 8)
// ---------------------------------------------------------------------------

export interface NestGuardChainEntry {
  route: string;
  method: string;
  controller: string;
  file: string;
  chain: Array<{
    /** G1: "middleware" layer for NestModule.configure(consumer) entries */
    layer: "global" | "controller" | "method" | "middleware";
    /** G4: "metadata" type for custom decorators like @Roles('admin') */
    type: "guard" | "interceptor" | "pipe" | "filter" | "metadata";
    name: string;
    file?: string;
    /** G4: raw decorator argument text (e.g., "admin" from @Roles('admin')) */
    args?: string;
  }>;
}

export interface NestGuardChainResult {
  routes: NestGuardChainEntry[];
  errors?: NestToolError[];
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers: guard/interceptor/pipe parsing (CQ14)
// ---------------------------------------------------------------------------

/** Parse @UseGuards(...) from source, returns guard class names.
 * R-8 fix: handles both class-ref form @UseGuards(AuthGuard) and
 * instantiation form @UseGuards(new ThrottlerGuard()). */
export function parseUseGuards(source: string): string[] {
  const results: string[] = [];
  // Match the full @UseGuards(...) arg including nested parens for `new Guard()`
  const re = /@UseGuards\s*\(\s*([^)]*(?:\([^)]*\)[^)]*)*)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const args = m[1]!;
    // Extract class names — both bare refs and `new ClassName(...)` instantiations
    for (const part of args.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const newMatch = /new\s+(\w+)/.exec(trimmed);
      if (newMatch) { results.push(newMatch[1]!); continue; }
      const bareMatch = /^(\w+)$/.exec(trimmed);
      if (bareMatch) results.push(bareMatch[1]!);
    }
  }
  return results;
}

/**
 * Factory for @Use*() decorator parsers. parseUseGuards is separate because
 * it needs to handle `new Guard()` instantiation form (R-8 fix).
 */
function makeUseDecoratorParser(decoratorName: string): (source: string) => string[] {
  const re = new RegExp(`@${decoratorName}\\s*\\(\\s*([\\w\\s,]+)\\s*\\)`, "g");
  return (source: string): string[] => {
    const results: string[] = [];
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(source)) !== null) {
      for (const name of m[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
        results.push(name);
      }
    }
    return results;
  };
}

const parseUseInterceptors = makeUseDecoratorParser("UseInterceptors");
const parseUsePipes = makeUseDecoratorParser("UsePipes");
const parseUseFilters = makeUseDecoratorParser("UseFilters");

/** Built-in NestJS decorators that should NOT be reported as custom metadata */
const BUILTIN_DECORATORS = new Set([
  "Get", "Post", "Put", "Delete", "Patch", "Options", "Head", "All",
  "Controller", "Injectable", "Module", "Global",
  "UseGuards", "UseInterceptors", "UsePipes", "UseFilters",
  "Param", "Body", "Query", "Headers", "Req", "Res", "Next", "Ip", "Session", "HostParam",
  "Version", "ApiOperation", "ApiBearerAuth", "ApiTags", "ApiResponse", "ApiProperty", "ApiParam", "ApiBody", "ApiQuery",
  "HealthCheck", "HealthIndicator",
  "Catch", "Optional", "Inject", "InjectRepository", "InjectModel",
  "Resolver", "Query" /*gql*/, "Mutation", "Subscription", "Args", "ResolveField",
  "WebSocketGateway", "SubscribeMessage", "MessageBody", "ConnectedSocket",
  "MessagePattern", "EventPattern", "Payload", "Ctx",
  "Cron", "Interval", "Timeout", "OnEvent",
  "Entity", "Column", "PrimaryGeneratedColumn", "PrimaryColumn", "OneToMany", "ManyToOne", "OneToOne", "ManyToMany",
  "JoinColumn", "JoinTable", "CreateDateColumn", "UpdateDateColumn", "DeleteDateColumn", "Index", "Unique",
]);

/**
 * G4: Parse custom decorators on methods (e.g. @Roles('admin'), @Public(), @CurrentUser()).
 * Returns decorator name + raw argument string (may be empty).
 * Excludes built-in NestJS decorators (BUILTIN_DECORATORS set).
 */
function parseCustomDecorators(source: string): Array<{ name: string; args: string }> {
  const results: Array<{ name: string; args: string }> = [];
  // Match @PascalCase(args) — capture name and argument text
  const re = /@([A-Z]\w*)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[1]!;
    if (BUILTIN_DECORATORS.has(name)) continue;
    // Strip quotes from simple string args for readable output
    const args = m[2]!.trim().replace(/^['"`]|['"`]$/g, "");
    results.push({ name, args });
  }
  return results;
}

type ChainItem = NestGuardChainEntry["chain"][number];

/** G1: glob-like matching for NestJS middleware forRoutes against resolved route paths */
function matchMiddlewareRoute(
  mwRoute: { path: string; method?: string },
  routePath: string,
  routeMethod: string,
): boolean {
  // Method filter
  if (mwRoute.method && mwRoute.method !== "ALL" && mwRoute.method !== routeMethod) return false;

  // Normalise both sides to leading-slash form for comparison
  const norm = (p: string) => "/" + p.replace(/^\/+|\/+$/g, "");
  const mwNorm = norm(mwRoute.path);
  const routeNorm = norm(routePath);

  // '*' matches everything
  if (mwNorm === "/*" || mwRoute.path === "*") return true;

  // Convert NestJS glob (users/*) into anchored regex
  // escape regex metachars except '*', then replace '*' with '.*'
  const escaped = mwNorm.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const re = new RegExp(`^${escaped}($|/)`);
  return re.test(routeNorm);
}

export async function nestGuardChain(
  repo: string,
  options?: { path?: string; max_routes?: number },
): Promise<NestGuardChainResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const maxRoutes = options?.max_routes ?? 300;
  const routes: NestGuardChainEntry[] = [];
  const errors: NestToolError[] = [];
  let truncated = false;

  // 1. Collect global guards/interceptors/pipes from module files + G1 middleware chains
  const globalChain: ChainItem[] = [];
  const middlewareEntries: Array<{ middleware: string; routes: Array<{ path: string; method?: string }>; file: string }> = [];
  for (const file of index.files) {
    if (!file.path.endsWith(".module.ts") && !file.path.endsWith(".module.js")) continue;
    let source: string;
    try { source = await readFile(join(index.root, file.path), "utf-8"); } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const conv = extractNestConventions(source, file.path);
    for (const g of conv.global_guards) globalChain.push({ layer: "global", type: "guard", name: g.name, file: g.file });
    for (const f of conv.global_filters) globalChain.push({ layer: "global", type: "filter", name: f.name, file: f.file });
    for (const p of conv.global_pipes) globalChain.push({ layer: "global", type: "pipe", name: p.name, file: p.file });
    for (const i of conv.global_interceptors) globalChain.push({ layer: "global", type: "interceptor", name: i.name, file: i.file });
    // G1: defensive default since middleware_chains is optional on older profiles
    for (const mw of conv.middleware_chains ?? []) {
      middlewareEntries.push({ middleware: mw.middleware, routes: mw.routes, file: mw.file });
    }
  }

  // 2. Scan controller files
  const controllerFiles = index.files.filter(
    (f) => f.path.endsWith(".controller.ts") || f.path.endsWith(".controller.js"),
  );
  const methods = ["Get", "Post", "Put", "Delete", "Patch", "All", "Head", "Options"];

  for (const file of controllerFiles) {
    if (routes.length >= maxRoutes) { truncated = true; break; }
    let source: string;
    try { source = await readFile(join(index.root, file.path), "utf-8"); } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    // Controller-level info
    const ctrlMatch = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]/.exec(source);
    const ctrlPrefix = ctrlMatch?.[1] ?? "";
    const ctrlClassMatch = /class\s+(\w+)/.exec(source);
    const ctrlClass = ctrlClassMatch?.[1] ?? "UnknownController";

    // Controller-level decorators (before class body — find source before first method)
    const classIdx = source.indexOf(`class ${ctrlClass}`);
    const ctrlHeader = classIdx >= 0 ? source.slice(0, classIdx) : "";
    const ctrlGuards: ChainItem[] = parseUseGuards(ctrlHeader).map((n) => ({ layer: "controller" as const, type: "guard" as const, name: n }));
    const ctrlInterceptors: ChainItem[] = parseUseInterceptors(ctrlHeader).map((n) => ({ layer: "controller" as const, type: "interceptor" as const, name: n }));
    const ctrlPipes: ChainItem[] = parseUsePipes(ctrlHeader).map((n) => ({ layer: "controller" as const, type: "pipe" as const, name: n }));
    const ctrlFilters: ChainItem[] = parseUseFilters(ctrlHeader).map((n) => ({ layer: "controller" as const, type: "filter" as const, name: n }));
    const ctrlLevelChain = [...ctrlGuards, ...ctrlInterceptors, ...ctrlPipes, ...ctrlFilters];

    // Collect ALL method decorator positions first to bound lookback correctly
    const allMethodPositions: Array<{ method: string; path: string; pos: number }> = [];
    for (const method of methods) {
      const reStr = new RegExp(`@${method}\\s*\\(\\s*['"\`]([^'"\`]*)['"\`]\\s*\\)`, "g");
      const reEmpty = new RegExp(`@${method}\\s*\\(\\s*\\)`, "g");
      let m: RegExpExecArray | null;
      while ((m = reStr.exec(source)) !== null) allMethodPositions.push({ method, path: m[1] ?? "", pos: m.index });
      while ((m = reEmpty.exec(source)) !== null) allMethodPositions.push({ method, path: "", pos: m.index });
    }
    allMethodPositions.sort((a, b) => a.pos - b.pos);

    for (let idx = 0; idx < allMethodPositions.length; idx++) {
      if (routes.length >= maxRoutes) { truncated = true; break; }
      const mm = allMethodPositions[idx]!;
      // Normalise: collapse slashes, trim trailing slash (except for root "/")
      const rawPath = `/${ctrlPrefix}/${mm.path}`.replace(/\/+/g, "/");
      const fullPath = rawPath.length > 1 ? rawPath.replace(/\/$/, "") : rawPath;

      if (options?.path && fullPath !== options.path) continue;

      // Lookback window: from previous method decorator (or class start) to current
      const prevEnd = idx > 0 ? allMethodPositions[idx - 1]!.pos + 10 : (classIdx >= 0 ? classIdx : 0);
      const methodCtx = source.slice(Math.max(prevEnd, 0), mm.pos);
      const methodGuards: ChainItem[] = parseUseGuards(methodCtx).map((n) => ({ layer: "method" as const, type: "guard" as const, name: n }));
      const methodInterceptors: ChainItem[] = parseUseInterceptors(methodCtx).map((n) => ({ layer: "method" as const, type: "interceptor" as const, name: n }));
      const methodPipes: ChainItem[] = parseUsePipes(methodCtx).map((n) => ({ layer: "method" as const, type: "pipe" as const, name: n }));
      const methodFilters: ChainItem[] = parseUseFilters(methodCtx).map((n) => ({ layer: "method" as const, type: "filter" as const, name: n }));

      // G4: custom decorators (e.g. @Roles('admin'), @Public()) — method-level only
      const methodMetadata: ChainItem[] = parseCustomDecorators(methodCtx).map((d) => ({
        layer: "method" as const,
        type: "metadata" as const,
        name: d.name,
        ...(d.args ? { args: d.args } : {}),
      }));

      // G1: match middleware entries against this route
      const middlewareChain: ChainItem[] = [];
      for (const mw of middlewareEntries) {
        for (const mwRoute of mw.routes) {
          if (matchMiddlewareRoute(mwRoute, fullPath, mm.method.toUpperCase())) {
            middlewareChain.push({ layer: "middleware", type: "guard", name: mw.middleware, file: mw.file });
            break;
          }
        }
      }

      routes.push({
        route: fullPath,
        method: mm.method.toUpperCase(),
        controller: ctrlClass,
        file: file.path,
        chain: [...globalChain, ...middlewareChain, ...ctrlLevelChain, ...methodGuards, ...methodInterceptors, ...methodPipes, ...methodFilters, ...methodMetadata],
      });
    }
  }

  return {
    routes,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}
