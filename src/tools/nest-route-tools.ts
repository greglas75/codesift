/**
 * NestJS route inventory analysis.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCodeIndex } from "./index-tools.js";
import { parseUseGuards } from "./nest-guard-tools.js";
import type { NestToolError } from "./nest-shared-tools.js";

// ---------------------------------------------------------------------------
// B4: nest_route_inventory — types (implementation in Task 9)
// ---------------------------------------------------------------------------

export interface NestRouteEntry {
  method: string;
  path: string;
  handler: string;
  controller: string;
  file: string;
  guards: string[];
  params: Array<{ decorator: string; name: string; type?: string }>;
  /** G9: method-level @Version or controller-level { version } */
  version?: string;
  /** G10: Swagger annotations */
  swagger?: { summary?: string; tags?: string[]; bearer?: boolean };
  /** G13: @HealthCheck() tagged */
  is_health_check?: boolean;
  /** G11: inline pipe names from @UsePipes(new ValidationPipe(...)) */
  inline_pipes?: string[];
}

export interface NestRouteInventoryResult {
  routes: NestRouteEntry[];
  stats: {
    total_routes: number;
    protected: number;
    unprotected: number;
  };
  errors?: NestToolError[];
  truncated?: boolean;
}

export async function nestRouteInventory(
  repo: string,
  options?: { max_routes?: number },
): Promise<NestRouteInventoryResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);

  const maxRoutes = options?.max_routes ?? 500;
  const errors: NestToolError[] = [];
  let truncated = false;

  // Use findNestJSHandlers with wildcard path to get ALL routes
  // We pass "/**" as a wildcard — but findNestJSHandlers uses matchPath which
  // doesn't support wildcards. Instead, we scan controllers ourselves.
  const controllerFiles = index.files.filter(
    (f) => f.path.endsWith(".controller.ts") || f.path.endsWith(".controller.js"),
  );

  const routes: NestRouteEntry[] = [];
  const methods = ["Get", "Post", "Put", "Delete", "Patch", "All", "Head", "Options"];

  for (const file of controllerFiles) {
    if (routes.length >= maxRoutes) { truncated = true; break; }
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch (err) {
      errors.push({ file: file.path, reason: `readFile failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const ctrlMatchStr = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]/.exec(source);
    // G9: also try @Controller({ path: '...', version: '...' }) object form
    const ctrlObjMatch = !ctrlMatchStr ? /@Controller\s*\(\s*\{[^}]*path:\s*['"`]([^'"`]*)['"`]/.exec(source) : null;
    const ctrlMatchEmpty = !ctrlMatchStr && !ctrlObjMatch ? /@Controller\s*\(\s*\)/.exec(source) : null;
    const ctrlPrefix = ctrlMatchStr?.[1] ?? ctrlObjMatch?.[1] ?? (ctrlMatchEmpty ? "" : "");
    const ctrlClassMatch = /class\s+(\w+)/.exec(source);
    const ctrlClass = ctrlClassMatch?.[1] ?? "UnknownController";

    // Guards at controller level
    const classIdx = source.indexOf(`class ${ctrlClass}`);
    const ctrlHeader = classIdx >= 0 ? source.slice(0, classIdx) : "";
    const ctrlGuards = parseUseGuards(ctrlHeader);
    // G9: controller-level version — method can override
    const ctrlVersion = parseControllerVersion(ctrlHeader);

    // Collect all method decorator positions first — enables bounded lookback per method
    const allMethodDecoratorPositions: Array<{ method: string; path: string; pos: number; matchLen: number }> = [];
    for (const method of methods) {
      const reStr = new RegExp(`@${method}\\s*\\(\\s*['"\`]([^'"\`]*)['"\`]\\s*\\)`, "g");
      const reEmpty = new RegExp(`@${method}\\s*\\(\\s*\\)`, "g");
      let m: RegExpExecArray | null;
      while ((m = reStr.exec(source)) !== null) {
        allMethodDecoratorPositions.push({ method, path: m[1] ?? "", pos: m.index, matchLen: m[0].length });
      }
      while ((m = reEmpty.exec(source)) !== null) {
        allMethodDecoratorPositions.push({ method, path: "", pos: m.index, matchLen: m[0].length });
      }
    }
    allMethodDecoratorPositions.sort((a, b) => a.pos - b.pos);

    for (let idx = 0; idx < allMethodDecoratorPositions.length; idx++) {
      if (routes.length >= maxRoutes) { truncated = true; break; }
      const mm = allMethodDecoratorPositions[idx]!;
      const handler = resolveHandlerName(source, mm.pos + mm.matchLen);
      if (!handler) continue;
      const rawPath = mm.path
        ? `/${ctrlPrefix}/${mm.path}`.replace(/\/+/g, "/")
        : `/${ctrlPrefix}`.replace(/\/+/g, "/") || "/";
      const fullPath = rawPath.length > 1 ? rawPath.replace(/\/$/, "") : rawPath;
      if (routes.some((r) => r.file === file.path && r.handler === handler && r.method === mm.method.toUpperCase())) continue;

      // Bounded backward lookback: from previous decorator end to current decorator start
      const prevEnd = idx > 0
        ? allMethodDecoratorPositions[idx - 1]!.pos + allMethodDecoratorPositions[idx - 1]!.matchLen + 20
        : (classIdx >= 0 ? classIdx : 0);
      routes.push(buildRouteBounded(mm.method, fullPath, handler, mm.pos, prevEnd));
    }

    // buildRoute is replaced by buildRouteBounded which takes the lookback start
    function buildRouteBounded(method: string, fullPath: string, handler: string, methodIdx: number, lookbackStart: number): NestRouteEntry {
      const before = source.slice(Math.max(lookbackStart, 0), methodIdx);
      let endPos = methodIdx + 800;
      const hNameRe = new RegExp(`\\b${handler}\\s*\\(`);
      const hMatch = hNameRe.exec(source.slice(methodIdx, methodIdx + 800));
      if (hMatch) endPos = methodIdx + hMatch.index;
      const after = source.slice(methodIdx, Math.min(source.length, endPos));
      const methodCtx = before + after;
      // Bound paramCtx to the method's own signature via paren counting —
      // prevents leakage from adjacent methods in the same file.
      const paramCtx = extractMethodSignature(source, endPos);
      const methodGuards = parseUseGuards(methodCtx);
      const allGuards = [...ctrlGuards, ...methodGuards];
      const methodVersion = parseVersionFromContext(methodCtx);
      const swagger = parseSwaggerFromContext(methodCtx, ctrlHeader);
      const healthCheck = isHealthCheck(methodCtx);
      const inlinePipes = parseInlinePipes(methodCtx);

      const entry: NestRouteEntry = {
        method: method.toUpperCase(),
        path: fullPath,
        handler,
        controller: ctrlClass,
        file: file.path,
        guards: allGuards,
        params: parseParamDecorators(paramCtx),
      };
      const version = methodVersion ?? ctrlVersion;
      if (version) entry.version = version;
      if (swagger) entry.swagger = swagger;
      if (healthCheck) entry.is_health_check = true;
      if (inlinePipes.length > 0) entry.inline_pipes = inlinePipes;
      return entry;
    }
  }

  const protectedCount = routes.filter((r) => r.guards.length > 0).length;
  return {
    routes,
    stats: {
      total_routes: routes.length,
      protected: protectedCount,
      unprotected: routes.length - protectedCount,
    },
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

/**
 * Extract the method parameter signature starting at the handler name position.
 * Paren-counts to find the matching `)` for the parameter list — prevents
 * scanning into adjacent methods which would produce duplicate @Param/@Body.
 */
function extractMethodSignature(source: string, handlerNamePos: number): string {
  // Find the opening paren of the handler's parameter list
  let i = handlerNamePos;
  // Skip handler name + whitespace
  while (i < source.length && /[\w\s]/.test(source[i]!)) i++;
  if (source[i] !== "(") return source.slice(handlerNamePos, Math.min(source.length, handlerNamePos + 400));
  // Paren-count to find matching close
  let depth = 1;
  const start = i + 1;
  i++;
  while (i < source.length && depth > 0) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") depth--;
    if (depth === 0) break;
    i++;
  }
  return source.slice(start, i);
}

/** Parse @Param/@Body/@Query decorators from source context */
function parseParamDecorators(source: string): NestRouteEntry["params"] {
  const params: NestRouteEntry["params"] = [];
  const re = /@(Param|Body|Query|Headers)\s*\(\s*(?:['"`](\w+)['"`])?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    params.push({ decorator: m[1]!, name: m[2] ?? "" });
  }
  return params;
}

/**
 * Resolve the method handler name after a @Get/@Post/etc decorator.
 * Skips intermediate stacked decorators (@Version, @ApiOperation, @UseGuards, etc.)
 * using paren counting to handle nested args like @UsePipes(new Pipe({...})).
 */
function resolveHandlerName(source: string, afterDecoratorPos: number): string | undefined {
  let pos = afterDecoratorPos;
  const maxScan = pos + 1000;
  while (pos < Math.min(source.length, maxScan)) {
    // Skip whitespace and newlines
    while (pos < source.length && /\s/.test(source[pos]!)) pos++;
    if (pos >= source.length) return undefined;

    // If we hit another decorator, skip the whole decorator including args (paren count)
    if (source[pos] === "@") {
      pos++; // skip @
      // skip decorator name
      while (pos < source.length && /\w/.test(source[pos]!)) pos++;
      // skip args if present (paren-counted)
      while (pos < source.length && /\s/.test(source[pos]!)) pos++;
      if (source[pos] === "(") {
        let depth = 1;
        pos++;
        while (pos < source.length && depth > 0) {
          if (source[pos] === "(") depth++;
          else if (source[pos] === ")") depth--;
          pos++;
        }
      }
      continue;
    }

    // Skip keywords like async, public, private
    const kwMatch = /^(?:async|public|private|protected)\s+/.exec(source.slice(pos));
    if (kwMatch) { pos += kwMatch[0].length; continue; }

    // Should now be at the method name
    const nameMatch = /^(\w+)\s*\(/.exec(source.slice(pos));
    if (nameMatch) return nameMatch[1]!;
    return undefined;
  }
  return undefined;
}

/** G9: Extract @Version('n') or @Controller({ version: 'n' }) — method-level takes precedence */
function parseVersionFromContext(methodCtx: string): string | undefined {
  const m = /@Version\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/.exec(methodCtx);
  return m ? m[1]! : undefined;
}

function parseControllerVersion(ctrlHeader: string): string | undefined {
  const m = /@Controller\s*\(\s*\{[^}]*version:\s*['"`]([^'"`]+)['"`]/.exec(ctrlHeader);
  return m ? m[1]! : undefined;
}

/** G10: Extract Swagger annotations */
function parseSwaggerFromContext(
  methodCtx: string,
  ctrlHeader: string,
): NestRouteEntry["swagger"] | undefined {
  const result: NonNullable<NestRouteEntry["swagger"]> = {};
  const summaryMatch = /@ApiOperation\s*\(\s*\{[^}]*summary:\s*['"`]([^'"`]+)['"`]/.exec(methodCtx);
  if (summaryMatch) result.summary = summaryMatch[1]!;
  if (/@ApiBearerAuth\s*\(/.test(methodCtx) || /@ApiBearerAuth\s*\(/.test(ctrlHeader)) {
    result.bearer = true;
  }
  const tagsMatch = /@ApiTags\s*\(\s*((?:['"`][^'"`]+['"`]\s*,?\s*)+)\)/.exec(ctrlHeader);
  if (tagsMatch) {
    const tags = [...tagsMatch[1]!.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]!);
    if (tags.length > 0) result.tags = tags;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** G13: Check for @HealthCheck() decorator on method */
function isHealthCheck(methodCtx: string): boolean {
  return /@HealthCheck\s*\(\s*\)/.test(methodCtx);
}

/** G11: Extract inline pipe constructions from @UsePipes(new ValidationPipe(...)) */
function parseInlinePipes(methodCtx: string): string[] {
  const pipes: string[] = [];
  const re = /@UsePipes\s*\(\s*new\s+(\w+Pipe)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(methodCtx)) !== null) pipes.push(m[1]!);
  return pipes;
}
