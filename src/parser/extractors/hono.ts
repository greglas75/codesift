/**
 * HonoExtractor — AST-based extractor for Hono framework applications.
 *
 * Parses a Hono entry file using tree-sitter TypeScript grammar and produces
 * a HonoAppModel that describes routes, middleware, context flow, OpenAPI
 * schemas, and RPC exports.
 *
 * Spec: docs/specs/2026-04-10-hono-framework-intelligence-spec.md
 * Plan: docs/specs/2026-04-10-hono-framework-intelligence-plan.md (Task 2-3)
 */

import { readFile } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type Parser from "web-tree-sitter";
import { getParser } from "../parser-manager.js";
import type {
  HonoApp,
  HonoAppModel,
  HonoMount,
  HonoRoute,
} from "./hono-model.js";
import { HonoMiddlewareExtractor } from "./hono-middleware-extractor.js";
import { pickLanguage, stringLiteralValue, walk } from "./hono-ast-utils.js";
import { HonoRouteExtractor } from "./hono-route-extractor.js";
import { HonoOpenAPIExtractor } from "./hono-openapi-extractor.js";
import { HonoContextExtractor } from "./hono-context-extractor.js";
import { HonoRuntimeExtractor } from "./hono-runtime-extractor.js";
import { walkHonoAppVariables } from "./hono-app-discovery.js";
import { joinPaths } from "./hono-route-utils.js";

/** Cached child model for memoized sub-app parsing (same file, different prefix). */
interface ChildParseResult {
  app_variables: Record<string, HonoApp>;
  routes: HonoRoute[];
  mounts: HonoMount[];
  files_used: string[];
}

export class HonoExtractor {
  private routeExtractor = new HonoRouteExtractor();
  private middlewareExtractor = new HonoMiddlewareExtractor();
  private openAPIExtractor = new HonoOpenAPIExtractor();
  private contextExtractor = new HonoContextExtractor();
  private runtimeExtractor = new HonoRuntimeExtractor();

  async parse(entryFile: string): Promise<HonoAppModel> {
    const absoluteEntry = canonicalize(path.resolve(entryFile));
    const model = emptyModel(absoluteEntry, {});
    const parsedCache = new Map<string, ChildParseResult>();
    await this.parseFile(absoluteEntry, "", new Set(), parsedCache, model);
    // Post-pass runtime upgrade: if the entry-file-only detector left runtime
    // as "unknown" but an imported file (e.g. bindings.ts) contains a CF
    // Worker type, promote runtime to "cloudflare". Real Hono apps commonly
    // isolate Bindings type definitions in a separate file.
    if (model.runtime === "unknown") {
      model.runtime = await this.runtimeExtractor.upgradeRuntimeFromImports(
        model.files_used,
      );
    }
    return model;
  }

  /**
   * Parse a single file and merge results into the model.
   * @param file Absolute canonicalized path
   * @param prefix Path prefix to apply to all routes (from parent app.route())
   * @param inFlight In-flight stack for cycle detection (pushed/popped per call)
   * @param parsedCache Memoized child models keyed by canonical path
   * @param model Accumulated model being built
   */
  private async parseFile(
    file: string,
    prefix: string,
    inFlight: Set<string>,
    parsedCache: Map<string, ChildParseResult>,
    model: HonoAppModel,
  ): Promise<void> {
    // Cycle detection: break if this file is already being parsed up the call stack
    if (inFlight.has(file)) {
      model.skip_reasons.parse_cycle_skipped =
        (model.skip_reasons.parse_cycle_skipped ?? 0) + 1;
      return;
    }

    // Record file as used
    if (!model.files_used.includes(file)) {
      model.files_used.push(file);
    }

    // Check memoization cache for previously parsed child
    const cached = parsedCache.get(file);
    if (cached) {
      // Re-run mount expansion FIRST: nested app.route() lives outside cached.routes;
      // a prior bug skipped this on cache hit so the 2nd+ mount missed grandchild routes.
      // Local route push is deferred to AFTER replay so a partial-graph state cannot leak
      // when the replay parse/walk fails (R-11).
      let replaySrc: string;
      try {
        replaySrc = await readFile(file, "utf-8");
      } catch {
        model.skip_reasons.file_read_failed =
          (model.skip_reasons.file_read_failed ?? 0) + 1;
        return;
      }
      const replayLang = pickLanguage(file);
      const replayParser = await getParser(replayLang);
      if (!replayParser) {
        model.skip_reasons.parser_unavailable =
          (model.skip_reasons.parser_unavailable ?? 0) + 1;
        return;
      }
      const replayTree = replayParser.parse(replaySrc);
      if (!replayTree) {
        model.skip_reasons.parse_failed =
          (model.skip_reasons.parse_failed ?? 0) + 1;
        return;
      }
      inFlight.add(file);
      try {
        const importMap = this.extractImportMap(replayTree.rootNode, file);
        const localMounts: HonoMount[] = [];
        await this.walkRouteMounts(
          replayTree.rootNode, file, prefix, cached.app_variables, importMap,
          inFlight, parsedCache, model, localMounts,
        );
        // Replay succeeded — now push local routes with fresh mount prefix.
        for (const route of cached.routes) {
          model.routes.push({
            ...route,
            path: joinPaths(prefix, route.path),
          });
        }
      } finally {
        inFlight.delete(file);
        replayTree.delete();
      }
      return;
    }

    let source: string;
    try {
      source = await readFile(file, "utf-8");
    } catch {
      model.skip_reasons.file_read_failed =
        (model.skip_reasons.file_read_failed ?? 0) + 1;
      return;
    }

    const language = pickLanguage(file);
    const parser = await getParser(language);
    if (!parser) {
      model.skip_reasons.parser_unavailable =
        (model.skip_reasons.parser_unavailable ?? 0) + 1;
      return;
    }

    const tree = parser.parse(source);
    if (!tree) {
      model.skip_reasons.parse_failed =
        (model.skip_reasons.parse_failed ?? 0) + 1;
      return;
    }

    try {
      // Track local data
      const localAppVars: Record<string, HonoApp> = {};
      const localRoutes: HonoRoute[] = [];
      const localMounts: HonoMount[] = [];
      const importMap = this.extractImportMap(tree.rootNode, file);

      // Walk for Hono app variables
      walkHonoAppVariables(tree.rootNode, file, localAppVars);

      // Merge local app variables into model
      for (const [name, app] of Object.entries(localAppVars)) {
        model.app_variables[name] = app;
      }

      // Walk for HTTP routes (not app.route — those are handled separately)
      this.routeExtractor.walkHttpRoutes(
        tree.rootNode,
        file,
        localAppVars,
        localRoutes,
      );

      // Apply mount prefix on top of routes (route.path already has basePath)
      for (const route of localRoutes) {
        model.routes.push({
          ...route,
          path: joinPaths(prefix, route.path),
        });
      }

      // Walk for context flow: c.set(), c.get(), c.var.*, c.env.*
      this.contextExtractor.walkContextFlow(tree.rootNode, file, model);

      // Walk for middleware chains: app.use("scope", mw1, mw2, ...)
      this.middlewareExtractor.walkMiddleware(
        tree.rootNode,
        file,
        localAppVars,
        model,
      );

      // Walk for RPC type exports: export type AppType = typeof app
      this.walkRPCExports(tree.rootNode, file, localAppVars, model);

      // Walk for OpenAPI: createRoute() definitions + app.openapi() registrations
      this.openAPIExtractor.walkOpenAPI(
        tree.rootNode,
        file,
        localAppVars,
        prefix,
        model,
      );

      // Scan imported files for context flow (middleware files like auth.ts)
      for (const [, importedFile] of importMap) {
        if (!model.files_used.includes(importedFile)) {
          model.files_used.push(importedFile);
        }
        await this.contextExtractor.scanFileForContextFlow(importedFile, model);
      }

      // Detect runtime and env bindings (only for entry file)
      if (file === model.entry_file) {
        model.runtime = await this.runtimeExtractor.detectRuntime(file);
        this.runtimeExtractor.extractEnvBindings(tree.rootNode, source, model);
      }

      // Walk for app.route() mounts — recursive into child files.
      // `inFlight.delete(file)` runs in `finally` so an exception in walkRouteMounts
      // cannot poison cycle detection for the rest of the parse (R-0).
      inFlight.add(file);
      try {
        await this.walkRouteMounts(
          tree.rootNode, file, prefix, localAppVars, importMap,
          inFlight, parsedCache, model, localMounts,
        );
      } finally {
        inFlight.delete(file);
      }

      // Cache after mounts so localMounts is complete; routes are mount-prefix-agnostic locals
      parsedCache.set(file, {
        app_variables: localAppVars,
        routes: localRoutes,
        mounts: localMounts,
        files_used: [file],
      });
    } finally {
      tree.delete();
    }
  }

  /**
   * Build a map of { variableName → absoluteFilePath } from import statements.
   */
  private extractImportMap(
    root: Parser.SyntaxNode,
    currentFile: string,
  ): Map<string, string> {
    const importMap = new Map<string, string>();
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "import_statement") return;
      const sourceNode = node.childForFieldName("source");
      if (!sourceNode) return;
      const specifier = stringLiteralValue(sourceNode);
      if (!specifier || !specifier.startsWith(".")) return;

      const resolved = resolveImportPath(currentFile, specifier);
      if (!resolved) return;

      // Default import: import X from "./file"
      const importClause = node.children.find(
        (c) => c.type === "import_clause",
      );
      if (!importClause) return;

      for (const child of importClause.namedChildren) {
        if (child.type === "identifier") {
          // default import
          importMap.set(child.text, resolved);
        }
        if (child.type === "named_imports") {
          for (const spec of child.namedChildren) {
            if (spec.type === "import_specifier") {
              const alias = spec.childForFieldName("alias");
              const name = spec.childForFieldName("name");
              const varName = alias?.text ?? name?.text;
              if (varName) importMap.set(varName, resolved);
            }
          }
        }
      }
    });
    return importMap;
  }

  /**
   * Walk for `export type X = typeof varName` declarations.
   * Classifies as "full_app" if varName is the root app (has mounts/middleware on it),
   * or "route_group" if it's a sub-router without child mounts.
   */
  private walkRPCExports(
    root: Parser.SyntaxNode,
    file: string,
    appVars: Record<string, HonoApp>,
    model: HonoAppModel,
  ): void {
    const cursor = root.walk();
    walk(cursor, (node) => {
      // export_statement > type_alias_declaration
      if (node.type !== "export_statement") return;
      const typeAlias = node.namedChildren.find(
        (c) => c.type === "type_alias_declaration",
      );
      if (!typeAlias) return;

      const nameNode = typeAlias.childForFieldName("name");
      const valueNode = typeAlias.childForFieldName("value");
      if (!nameNode || !valueNode) return;

      // typeof <varName>
      if (valueNode.type !== "type_query") return;
      const queryArg = valueNode.namedChildren[0];
      if (!queryArg || queryArg.type !== "identifier") return;
      const sourceVar = queryArg.text;

      // Must reference a known Hono app variable
      if (!appVars[sourceVar]) return;

      // Classify: full_app if the variable is the root entry (has mounts), else route_group
      const hasMounts = model.mounts.some((m) => m.parent_var === sourceVar);
      const hasMiddleware = model.middleware_chains.some((mc) => mc.owner_var === sourceVar);
      const shape = (hasMounts || hasMiddleware) ? "full_app" : "route_group";

      model.rpc_exports.push({
        export_name: nameNode.text,
        file,
        line: node.startPosition.row + 1,
        shape,
        source_var: sourceVar,
      });
    });
  }

  /**
   * Walk for app.route("/prefix", subApp) calls.
   * Resolves subApp import, recursively parses the file.
   */
  private async walkRouteMounts(
    root: Parser.SyntaxNode,
    _file: string,
    parentPrefix: string,
    appVars: Record<string, HonoApp>,
    importMap: Map<string, string>,
    inFlight: Set<string>,
    parsedCache: Map<string, ChildParseResult>,
    model: HonoAppModel,
    localMounts: HonoMount[],
  ): Promise<void> {
    const mounts: Array<{
      mountPath: string;
      childVar: string;
      line: number;
      parentVar: string;
    }> = [];
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "call_expression") return;
      const fnNode = node.childForFieldName("function");
      const argsNode = node.childForFieldName("arguments");
      if (!fnNode || !argsNode || fnNode.type !== "member_expression") return;

      const objectNode = fnNode.childForFieldName("object");
      const propertyNode = fnNode.childForFieldName("property");
      if (!objectNode || !propertyNode || objectNode.type !== "identifier")
        return;

      const ownerVar = objectNode.text;
      if (!appVars[ownerVar]) return;
      const methodName = propertyNode.text;

      // app.mount("/legacy", handler) — non-Hono external handler mount
      if (methodName === "mount") {
        const args = argsNode.namedChildren;
        if (args.length < 2) return;
        const pathArg = args[0];
        if (!pathArg) return;
        const mountPath = stringLiteralValue(pathArg);
        if (mountPath == null) return;
        const basePrefix = appVars[ownerVar]?.base_path || "";
        const fullMountPath = joinPaths(parentPrefix || basePrefix, mountPath);
        const mount: HonoMount = {
          parent_var: ownerVar,
          mount_path: fullMountPath,
          child_var: "<external>",
          child_file: "",
          mount_type: "hono_mount",
        };
        model.mounts.push(mount);
        localMounts.push(mount);
        return;
      }

      if (methodName !== "route") return;

      const argList = argsNode.namedChildren;
      if (argList.length < 2) return;
      const pathArg = argList[0];
      const childArg = argList[1];
      if (!pathArg || !childArg) return;

      const mountPath = stringLiteralValue(pathArg);
      if (mountPath == null) return;
      const childVar =
        childArg.type === "identifier" ? childArg.text : null;
      if (!childVar) return;

      mounts.push({
        mountPath,
        childVar,
        line: node.startPosition.row + 1,
        parentVar: ownerVar,
      });
    });

    // Process mounts — async because recursive parse needs file I/O
    for (const { mountPath, childVar, parentVar } of mounts) {
      // T6: Fallback for LOCAL sub-apps (declared in the same file, not
      // imported). If the import map doesn't know this var but appVars does,
      // the child lives in the parent file — use that path instead of "".
      // Routes on the local sub-app were already captured by walkHttpRoutes
      // on the same root, so we record the mount without re-parsing.
      let childFile = importMap.get(childVar);
      let resolvedViaLocal = false;
      if (!childFile && appVars[childVar]) {
        childFile = appVars[childVar].file;
        resolvedViaLocal = true;
      }
      const fullMountPath = joinPaths(parentPrefix, mountPath);

      const mount: HonoMount = {
        parent_var: parentVar,
        mount_path: fullMountPath,
        child_var: childVar,
        child_file: childFile ?? "",
        mount_type: "hono_route",
      };
      model.mounts.push(mount);
      localMounts.push(mount);

      if (resolvedViaLocal) {
        // Local sub-app — routes already live in the parent file, no recursion.
        continue;
      }
      if (childFile && existsSync(childFile)) {
        await this.parseFile(childFile, fullMountPath, inFlight, parsedCache, model);
      } else {
        model.skip_reasons.unresolved_import =
          (model.skip_reasons.unresolved_import ?? 0) + 1;
      }
    }
  }

}

// --- Utility functions ---

function emptyModel(
  entryFile: string,
  skipReasons: Record<string, number>,
): HonoAppModel {
  return {
    entry_file: entryFile,
    app_variables: {},
    routes: [],
    mounts: [],
    middleware_chains: [],
    context_vars: [],
    openapi_routes: [],
    rpc_exports: [],
    runtime: "unknown",
    env_bindings: [],
    files_used: [],
    extraction_status: Object.keys(skipReasons).length > 0 ? "partial" : "complete",
    skip_reasons: skipReasons,
  };
}


/**
 * Resolve a relative import specifier to an absolute file path.
 * Tries: exact path, .ts, .js, /index.ts, /index.js extensions.
 */
function resolveImportPath(
  fromFile: string,
  importSpecifier: string,
): string | null {
  const dir = path.dirname(fromFile);
  const base = path.resolve(dir, importSpecifier);

  // Try with various extensions — .ts fixture files imported as .js in ESM
  const candidates = [
    base,
    base + ".ts",
    base + ".tsx",
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.jsx$/, ".tsx"),
    path.join(base, "index.ts"),
    path.join(base, "index.js"),
  ];

  for (const candidate of candidates) {
    if (isExistingFile(candidate)) {
      return canonicalize(candidate);
    }
  }
  return null;
}

function isExistingFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Canonicalize path via realpath for consistent cache invalidation.
 * Falls back to the input path if the file doesn't exist.
 */
function canonicalize(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}
