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
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type Parser from "web-tree-sitter";
import { getParser } from "../parser-manager.js";
import type {
  HonoApp,
  HonoAppModel,
  HonoHandler,
  HonoMethod,
  HonoMount,
  HonoRoute,
  MiddlewareEntry,
  ContextVariable,
  OpenAPIRoute,
  InlineHandlerAnalysis,
  ConditionalApplication,
} from "./hono-model.js";
import { HonoInlineAnalyzer } from "./hono-inline-analyzer.js";

const HTTP_METHODS = new Set([
  "get", "post", "put", "delete", "patch", "options", "all", "on",
]);

/** Cached child model for memoized sub-app parsing (same file, different prefix). */
interface ChildParseResult {
  app_variables: Record<string, HonoApp>;
  routes: HonoRoute[];
  mounts: HonoMount[];
  files_used: string[];
}

export class HonoExtractor {
  private inlineAnalyzer = new HonoInlineAnalyzer();

  async parse(entryFile: string): Promise<HonoAppModel> {
    const absoluteEntry = canonicalize(path.resolve(entryFile));
    const model = emptyModel(absoluteEntry, {});
    const parsedCache = new Map<string, ChildParseResult>();
    await this.parseFile(absoluteEntry, "", new Set(), parsedCache, model);
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
    if (inFlight.has(file)) return;

    // Record file as used
    if (!model.files_used.includes(file)) {
      model.files_used.push(file);
    }

    // Check memoization cache for previously parsed child
    const cached = parsedCache.get(file);
    if (cached) {
      // Re-use parsed routes with fresh prefix
      // route.path already has basePath applied — apply mount prefix on top
      for (const route of cached.routes) {
        model.routes.push({
          ...route,
          path: joinPaths(prefix, route.path),
        });
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
      this.walkAppVariables(tree.rootNode, file, localAppVars);

      // Merge local app variables into model
      for (const [name, app] of Object.entries(localAppVars)) {
        model.app_variables[name] = app;
      }

      // Walk for HTTP routes (not app.route — those are handled separately)
      this.walkHttpRoutes(tree.rootNode, file, localAppVars, localRoutes);

      // Apply mount prefix on top of routes (route.path already has basePath)
      for (const route of localRoutes) {
        model.routes.push({
          ...route,
          path: joinPaths(prefix, route.path),
        });
      }

      // Walk for context flow: c.set(), c.get(), c.var.*, c.env.*
      this.walkContextFlow(tree.rootNode, file, model);

      // Walk for middleware chains: app.use("scope", mw1, mw2, ...)
      this.walkMiddleware(tree.rootNode, file, localAppVars, importMap, model);

      // Walk for RPC type exports: export type AppType = typeof app
      this.walkRPCExports(tree.rootNode, file, localAppVars, model);

      // Walk for OpenAPI: createRoute() definitions + app.openapi() registrations
      this.walkOpenAPI(tree.rootNode, file, localAppVars, prefix, model);

      // Scan imported files for context flow (middleware files like auth.ts)
      for (const [, importedFile] of importMap) {
        if (!model.files_used.includes(importedFile)) {
          model.files_used.push(importedFile);
        }
        await this.scanFileForContextFlow(importedFile, model);
      }

      // Detect runtime and env bindings (only for entry file)
      if (file === model.entry_file) {
        model.runtime = await this.detectRuntime(file);
        this.extractEnvBindings(tree.rootNode, source, model);
      }

      // Cache local parse result (routes stored with raw_path, prefix applied on read)
      parsedCache.set(file, {
        app_variables: localAppVars,
        routes: localRoutes,
        mounts: localMounts,
        files_used: [file],
      });

      // Walk for app.route() mounts — recursive into child files
      inFlight.add(file);
      await this.walkRouteMounts(
        tree.rootNode, file, prefix, localAppVars, importMap,
        inFlight, parsedCache, model, localMounts,
      );
      inFlight.delete(file);
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

  private walkAppVariables(
    root: Parser.SyntaxNode,
    file: string,
    localVars: Record<string, HonoApp>,
  ): void {
    // First pass: detect factory variables (createFactory<Env>())
    const factoryVars = new Set<string>();
    const cursor1 = root.walk();
    walk(cursor1, (node) => {
      if (node.type !== "variable_declarator") return;
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (!nameNode || !valueNode || nameNode.type !== "identifier") return;
      if (isCreateFactoryCall(valueNode)) {
        factoryVars.add(nameNode.text);
      }
    });

    // Second pass: detect Hono app variables
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "variable_declarator") return;
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (!nameNode || !valueNode) return;
      if (nameNode.type !== "identifier") return;
      const name = nameNode.text;

      // Direct creation: new Hono(), new OpenAPIHono()
      const createdVia = classifyAppCreation(valueNode);
      if (createdVia) {
        localVars[name] = {
          variable_name: name,
          file,
          line: nameNode.startPosition.row + 1,
          created_via: createdVia,
          base_path: "",
        };
        return;
      }

      // basePath derivation: const v1 = app.basePath("/v1")
      const basePath = extractBasePathCall(valueNode, localVars);
      if (basePath) {
        localVars[name] = {
          variable_name: name,
          file,
          line: nameNode.startPosition.row + 1,
          created_via: "basePath",
          base_path: basePath.prefix,
          parent: basePath.parentVar,
        };
        return;
      }

      // factory.createApp(): const api = factory.createApp()
      if (isFactoryCreateApp(valueNode, factoryVars)) {
        localVars[name] = {
          variable_name: name,
          file,
          line: nameNode.startPosition.row + 1,
          created_via: "factory.createApp",
          base_path: "",
        };
      }
    });
  }

  private walkHttpRoutes(
    root: Parser.SyntaxNode,
    file: string,
    appVars: Record<string, HonoApp>,
    routes: HonoRoute[],
  ): void {
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
      const appDef = appVars[ownerVar];
      if (!appDef) return;

      const method = propertyNode.text.toLowerCase();
      if (!HTTP_METHODS.has(method) || method === "use" || method === "route")
        return;

      const argList = argsNode.namedChildren;
      if (argList.length === 0) return;

      // basePath prefix inherited from the HonoApp variable
      const basePrefix = appDef.base_path || "";

      // Handle app.on(["GET", "POST"], "/path", handler) — fan out
      if (method === "on") {
        this.handleOnMethod(argList, file, node, ownerVar, basePrefix, routes);
        return;
      }

      const firstArg = argList[0];
      if (!firstArg) return;
      const rawPath = stringLiteralValue(firstArg);
      if (rawPath == null) return;

      // Resolve once so buildHandler and analyzeHandlerIfInline see the same node.
      const handlerNode = argList[argList.length - 1] ?? firstArg;
      const handler: HonoHandler = buildHandler(handlerNode, file);
      const regexConstraint = parseRegexConstraints(rawPath);
      const inlineAnalysis = this.analyzeHandlerIfInline(handler, handlerNode);

      routes.push({
        method: method.toUpperCase() as HonoMethod,
        path: joinPaths(basePrefix, rawPath),
        raw_path: rawPath,
        file,
        line: node.startPosition.row + 1,
        owner_var: ownerVar,
        handler,
        inline_middleware: [],
        validators: [],
        ...(regexConstraint ? { regex_constraint: regexConstraint } : {}),
        ...(inlineAnalysis ? { inline_analysis: inlineAnalysis } : {}),
      });
    });
  }

  /**
   * Run InlineHandlerAnalyzer on the handler AST node when buildHandler
   * classified the handler as inline. Returns undefined for named-identifier
   * handlers — those are defined elsewhere and analyzed via their symbol.
   * The caller must pass the SAME node used by buildHandler so the two
   * decisions cannot disagree.
   */
  private analyzeHandlerIfInline(
    handler: HonoHandler,
    handlerNode: Parser.SyntaxNode,
  ): InlineHandlerAnalysis | undefined {
    if (!handler.inline) return undefined;
    return this.inlineAnalyzer.analyze(handlerNode);
  }

  /** Handle app.on(methods, path, handler) — fan out into per-method routes. */
  private handleOnMethod(
    argList: Parser.SyntaxNode[],
    file: string,
    node: Parser.SyntaxNode,
    ownerVar: string,
    basePrefix: string,
    routes: HonoRoute[],
  ): void {
    if (argList.length < 2) return;
    const methodsArg = argList[0];
    const pathArg = argList[1];
    if (!methodsArg || !pathArg) return;

    // Methods: string or array of strings
    const methods: string[] = [];
    if (methodsArg.type === "array") {
      for (const el of methodsArg.namedChildren) {
        const v = stringLiteralValue(el);
        if (v) methods.push(v.toUpperCase());
      }
    } else {
      const v = stringLiteralValue(methodsArg);
      if (v) methods.push(v.toUpperCase());
    }
    if (methods.length === 0) return;

    const rawPath = stringLiteralValue(pathArg);
    if (rawPath == null) return;

    // Resolve once so buildHandler and analyzeHandlerIfInline see the same node.
    const handlerNode = argList[argList.length - 1] ?? pathArg;
    const handler: HonoHandler = buildHandler(handlerNode, file);
    const regexConstraint = parseRegexConstraints(rawPath);
    const inlineAnalysis = this.analyzeHandlerIfInline(handler, handlerNode);

    for (const m of methods) {
      routes.push({
        method: m as HonoMethod,
        path: joinPaths(basePrefix, rawPath),
        raw_path: rawPath,
        file,
        line: node.startPosition.row + 1,
        owner_var: ownerVar,
        handler,
        inline_middleware: [],
        validators: [],
        ...(regexConstraint ? { regex_constraint: regexConstraint } : {}),
        ...(inlineAnalysis ? { inline_analysis: inlineAnalysis } : {}),
      });
    }
  }

  /**
   * Walk for app.use(scope, mw1, mw2, ...) calls.
   * Handles: identifiers, inline arrows, some()/every() from hono/combine,
   * spread arrays, call expressions like cors().
   */
  private walkMiddleware(
    root: Parser.SyntaxNode,
    file: string,
    appVars: Record<string, HonoApp>,
    _importMap: Map<string, string>,
    model: HonoAppModel,
  ): void {
    // Build local variable → array declaration map for spread expansion
    const arrayVars = this.collectArrayVars(root);
    // Identify which imported names come from which packages
    const importSources = this.collectImportSources(root);

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
      if (propertyNode.text !== "use") return;

      const argList = argsNode.namedChildren;
      if (argList.length === 0) return;

      // First arg may be a scope path string, or directly a middleware
      let scope = "*";
      let mwStartIdx = 0;
      const firstArg = argList[0];
      if (firstArg) {
        const maybeScope = stringLiteralValue(firstArg);
        if (maybeScope != null) {
          scope = maybeScope;
          mwStartIdx = 1;
        }
      }

      const entries: MiddlewareEntry[] = [];
      let order = 0;

      for (let i = mwStartIdx; i < argList.length; i++) {
        const arg = argList[i];
        if (!arg) continue;
        order++;

        // Spread: ...adminChain
        if (arg.type === "spread_element") {
          const inner = arg.namedChildren[0];
          if (inner?.type === "identifier") {
            const arrItems = arrayVars.get(inner.text);
            if (arrItems) {
              for (const item of arrItems) {
                entries.push(this.buildMiddlewareEntry(
                  item, file, node.startPosition.row + 1, order++,
                  importSources, undefined,
                ));
              }
            }
          }
          continue;
        }

        // some(mw1, mw2) / every(mw1, mw2) from hono/combine
        if (arg.type === "call_expression") {
          const callFn = arg.childForFieldName("function");
          const callArgs = arg.childForFieldName("arguments");
          if (callFn?.type === "identifier" &&
            (callFn.text === "some" || callFn.text === "every") && callArgs) {
            const combineType = callFn.text;
            for (const innerArg of callArgs.namedChildren) {
              entries.push(this.buildMiddlewareEntry(
                innerArg.type === "identifier" ? innerArg.text : "<inline>",
                file, innerArg.startPosition.row + 1, order++,
                importSources, combineType,
              ));
            }
            continue;
          }
        }

        // Regular middleware: identifier, call expression, or inline arrow
        const mwName = this.extractMiddlewareName(arg);
        entries.push(this.buildMiddlewareEntry(
          mwName, file, arg.startPosition.row + 1, order,
          importSources, undefined,
        ));

        // T4: If this is an inline arrow, scan its body for conditional
        // middleware calls like `if (cond) return mw(c, next)`. Each match
        // produces an ADDITIONAL entry with applied_when set.
        if (
          arg.type === "arrow_function" ||
          arg.type === "function_expression"
        ) {
          const conditional = this.detectConditionalMiddlewareCalls(arg);
          for (const found of conditional) {
            order++;
            const extra = this.buildMiddlewareEntry(
              found.name,
              file,
              found.line,
              order,
              importSources,
              undefined,
            );
            extra.conditional = true;
            extra.applied_when = found.applied_when;
            entries.push(extra);
          }
        }
      }

      if (entries.length > 0) {
        // Merge into existing chain for same scope, or create new
        const existing = model.middleware_chains.find(
          (mc) => mc.scope === scope && mc.owner_var === ownerVar,
        );
        if (existing) {
          existing.entries.push(...entries);
        } else {
          // scope_pattern is the raw scope (e.g., "*" or "/api/*") — downstream
          // tools compile to regex via compileScopePattern()
          model.middleware_chains.push({
            scope,
            scope_pattern: scope,
            owner_var: ownerVar,
            entries,
          });
        }
      }
    });
  }

  /**
   * T4: walk an inline middleware arrow body and surface any conditional
   * calls of the form `if (cond) return mw(c, next)` or `if (cond) await mw(c, next)`.
   *
   * We only inspect the DIRECT `if` statements at the top of the body (one level
   * of `statement_block` / `return_statement`). Deep nesting is out of scope to
   * keep false positives low.
   *
   * Returns an entry per conditional call found, with name + condition info.
   */
  private detectConditionalMiddlewareCalls(
    fnNode: Parser.SyntaxNode,
  ): Array<{ name: string; line: number; applied_when: ConditionalApplication }> {
    const results: Array<{
      name: string;
      line: number;
      applied_when: ConditionalApplication;
    }> = [];
    // Arrow function body is either an expression or a statement_block
    const block = fnNode.childForFieldName("body");
    if (!block) return results;
    // Only walk if the arrow body is a statement_block — expression-body
    // arrows `(c) => foo(c, next)` are NOT conditional by definition.
    if (block.type !== "statement_block") return results;

    for (let i = 0; i < block.childCount; i++) {
      const stmt = block.child(i);
      if (stmt?.type !== "if_statement") continue;
      const condition = stmt.childForFieldName("condition");
      const consequence = stmt.childForFieldName("consequence");
      if (!condition || !consequence) continue;

      // Resolve block-local `const x = mwFactory({...})` aliases so that
      //   const auth = basicAuth({...});
      //   return auth(c, next);
      // reports "basicAuth" instead of "auth".
      const localAliases = collectLocalAliases(consequence);

      // Find mw call inside the consequence.
      const mwCall = findMiddlewareCallInBlock(consequence);
      if (!mwCall) continue;

      const rawName = extractCallCalleeName(mwCall);
      if (!rawName) continue;
      const name = localAliases.get(rawName) ?? rawName;

      const condText = condition.text.slice(0, 200);
      const applied_when: ConditionalApplication = {
        condition_type: classifyConditionType(condition),
        condition_text: condText,
      };
      results.push({
        name,
        line: mwCall.startPosition.row + 1,
        applied_when,
      });
    }
    return results;
  }

  private extractMiddlewareName(node: Parser.SyntaxNode): string {
    if (node.type === "identifier") return node.text;
    if (node.type === "arrow_function" || node.type === "function_expression") {
      return "<inline>";
    }
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn?.type === "identifier") return fn.text;
      if (fn?.type === "member_expression") {
        const prop = fn.childForFieldName("property");
        return prop?.text ?? "<inline>";
      }
    }
    return "<inline>";
  }

  private buildMiddlewareEntry(
    name: string,
    file: string,
    line: number,
    order: number,
    importSources: Map<string, string>,
    expandedFrom: string | undefined,
  ): MiddlewareEntry {
    const importedFrom = importSources.get(name);
    const isThirdParty = !!importedFrom && (
      importedFrom.startsWith("hono/") ||
      !importedFrom.startsWith(".")
    );
    const entry: MiddlewareEntry = {
      name,
      order,
      line,
      file,
      inline: name === "<inline>",
      is_third_party: isThirdParty,
      conditional: expandedFrom === "some",
    };
    if (importedFrom) entry.imported_from = importedFrom;
    if (expandedFrom) entry.expanded_from = expandedFrom;
    return entry;
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
   * Walk for createRoute() definitions and app.openapi(route, handler) registrations.
   * - createRoute({method, path, ...}) → tracked in a local map by variable name
   * - app.openapi(routeVar, handler) → emits OpenAPIRoute + adds to model.routes
   */
  private walkOpenAPI(
    root: Parser.SyntaxNode,
    file: string,
    appVars: Record<string, HonoApp>,
    prefix: string,
    model: HonoAppModel,
  ): void {
    // First pass: collect createRoute() variable definitions
    const routeDefs = new Map<string, { method: string; path: string; line: number }>();
    const cursor1 = root.walk();
    walk(cursor1, (node) => {
      if (node.type !== "variable_declarator") return;
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (!nameNode || !valueNode || nameNode.type !== "identifier") return;
      if (valueNode.type !== "call_expression") return;
      const fn = valueNode.childForFieldName("function");
      if (!fn || fn.text !== "createRoute") return;

      const args = valueNode.childForFieldName("arguments");
      const objArg = args?.namedChildren[0];
      if (!objArg || objArg.type !== "object") return;

      let method = "";
      let routePath = "";
      for (const prop of objArg.namedChildren) {
        if (prop.type !== "pair") continue;
        const key = prop.childForFieldName("key");
        const val = prop.childForFieldName("value");
        if (!key || !val) continue;
        if (key.text === "method") {
          method = stringLiteralValue(val) ?? "";
        }
        if (key.text === "path") {
          routePath = stringLiteralValue(val) ?? "";
        }
      }
      if (method && routePath) {
        routeDefs.set(nameNode.text, {
          method,
          path: routePath,
          line: node.startPosition.row + 1,
        });
      }
    });

    // Second pass: find app.openapi(routeVar, handler) calls
    const cursor2 = root.walk();
    walk(cursor2, (node) => {
      if (node.type !== "call_expression") return;
      const fnNode = node.childForFieldName("function");
      const argsNode = node.childForFieldName("arguments");
      if (!fnNode || !argsNode || fnNode.type !== "member_expression") return;

      const obj = fnNode.childForFieldName("object");
      const prop = fnNode.childForFieldName("property");
      if (!obj || !prop || obj.type !== "identifier") return;
      if (!appVars[obj.text]) return;
      if (prop.text !== "openapi") return;

      const argList = argsNode.namedChildren;
      if (argList.length < 2) return;
      const routeRef = argList[0];
      const handlerArg = argList[1];
      if (!routeRef || !handlerArg) return;
      if (routeRef.type !== "identifier") return;

      const routeDef = routeDefs.get(routeRef.text);
      if (!routeDef) return;

      const honoPath = routeDef.path.replace(/\{(\w+)\}/g, ":$1");
      const openapiRoute: OpenAPIRoute = {
        id: `openapi_${routeRef.text}`,
        method: routeDef.method,
        path: routeDef.path,
        hono_path: honoPath,
        request_schemas: {},
        response_schemas: {},
        middleware: [],
        hidden: false,
        file,
        line: routeDef.line,
      };
      model.openapi_routes.push(openapiRoute);

      // Also add as a regular route
      const handler = buildHandler(handlerArg, file);
      model.routes.push({
        method: routeDef.method.toUpperCase() as HonoMethod,
        path: joinPaths(prefix, honoPath),
        raw_path: honoPath,
        file,
        line: node.startPosition.row + 1,
        owner_var: obj.text,
        handler,
        inline_middleware: [],
        validators: [],
        openapi_route_id: openapiRoute.id,
      });
    });
  }

  /**
   * Lightweight scan of an imported file (e.g., middleware) for context flow only.
   * Does not extract routes or mounts — just c.set/c.get/c.var patterns.
   */
  private async scanFileForContextFlow(
    file: string,
    model: HonoAppModel,
  ): Promise<void> {
    let source: string;
    try {
      source = await readFile(file, "utf-8");
    } catch {
      return;
    }
    const parser = await getParser(pickLanguage(file));
    if (!parser) return;
    const tree = parser.parse(source);
    if (!tree) return;
    try {
      this.walkContextFlow(tree.rootNode, file, model);
    } finally {
      tree.delete();
    }
  }

  /**
   * Walk for context variable flow: c.set("key", val), c.get("key"), c.var.key, c.env.KEY.
   * Detects conditional sets (inside if/try/switch blocks).
   */
  private walkContextFlow(
    root: Parser.SyntaxNode,
    file: string,
    model: HonoAppModel,
  ): void {
    const varsMap = new Map<string, ContextVariable>();

    const getOrCreate = (name: string, isEnv: boolean): ContextVariable => {
      let cv = varsMap.get(name);
      if (!cv) {
        cv = { name, set_points: [], get_points: [], is_env_binding: isEnv };
        varsMap.set(name, cv);
      }
      return cv;
    };

    const cursor = root.walk();
    walk(cursor, (node) => {
      // c.set("key", value)
      if (node.type === "call_expression") {
        const fn = node.childForFieldName("function");
        if (fn?.type === "member_expression") {
          const obj = fn.childForFieldName("object");
          const prop = fn.childForFieldName("property");
          if (obj?.text === "c" && prop?.text === "set") {
            const args = node.childForFieldName("arguments");
            const keyArg = args?.namedChildren[0];
            if (keyArg) {
              const key = stringLiteralValue(keyArg);
              if (key) {
                const cv = getOrCreate(key, false);
                cv.set_points.push({
                  file,
                  line: node.startPosition.row + 1,
                  scope: "middleware",
                  via_context_storage: false,
                  condition: isInsideBranch(node) ? "conditional" : "always",
                });
              }
            }
          }
          // c.get("key")
          if (obj?.text === "c" && prop?.text === "get") {
            const args = node.childForFieldName("arguments");
            const keyArg = args?.namedChildren[0];
            if (keyArg) {
              const key = stringLiteralValue(keyArg);
              if (key) {
                const cv = getOrCreate(key, false);
                cv.get_points.push({
                  file,
                  line: node.startPosition.row + 1,
                  scope: "handler",
                  via_context_storage: false,
                  condition: "always",
                });
              }
            }
          }
        }
      }

      // c.var.key — member_expression chain: c.var.key → (c.var).key
      if (node.type === "member_expression") {
        const obj = node.childForFieldName("object");
        const prop = node.childForFieldName("property");
        if (obj?.type === "member_expression" && prop) {
          const innerObj = obj.childForFieldName("object");
          const innerProp = obj.childForFieldName("property");
          if (innerObj?.text === "c" && innerProp?.text === "var") {
            const cv = getOrCreate(prop.text, false);
            cv.get_points.push({
              file,
              line: node.startPosition.row + 1,
              scope: "handler",
              via_context_storage: false,
              condition: "always",
            });
          }
        }
      }
    });

    // Merge into model.context_vars
    for (const cv of varsMap.values()) {
      const existing = model.context_vars.find((e) => e.name === cv.name);
      if (existing) {
        existing.set_points.push(...cv.set_points);
        existing.get_points.push(...cv.get_points);
      } else {
        model.context_vars.push(cv);
      }
    }
  }

  /** Collect local array variable declarations: const adminChain = [authMw, tenantMw] */
  private collectArrayVars(root: Parser.SyntaxNode): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "variable_declarator") return;
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (!nameNode || !valueNode || nameNode.type !== "identifier") return;
      if (valueNode.type !== "array") return;
      const items: string[] = [];
      for (const el of valueNode.namedChildren) {
        if (el.type === "identifier") items.push(el.text);
      }
      if (items.length > 0) result.set(nameNode.text, items);
    });
    return result;
  }

  /** Collect import source mapping: variableName → packageSpecifier */
  private collectImportSources(root: Parser.SyntaxNode): Map<string, string> {
    const result = new Map<string, string>();
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "import_statement") return;
      const sourceNode = node.childForFieldName("source");
      if (!sourceNode) return;
      const specifier = stringLiteralValue(sourceNode);
      if (!specifier) return;

      const importClause = node.children.find((c) => c.type === "import_clause");
      if (!importClause) return;
      for (const child of importClause.namedChildren) {
        if (child.type === "identifier") {
          result.set(child.text, specifier);
        }
        if (child.type === "named_imports") {
          for (const spec of child.namedChildren) {
            if (spec.type === "import_specifier") {
              const alias = spec.childForFieldName("alias");
              const name = spec.childForFieldName("name");
              const varName = alias?.text ?? name?.text;
              if (varName) result.set(varName, specifier);
            }
          }
        }
      }
    });
    return result;
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
    const mounts: Array<{ mountPath: string; childVar: string; line: number }> = [];
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
      });
    });

    // Process mounts — async because recursive parse needs file I/O
    for (const { mountPath, childVar } of mounts) {
      const childFile = importMap.get(childVar);
      const fullMountPath = joinPaths(parentPrefix, mountPath);

      const mount: HonoMount = {
        parent_var: Object.keys(appVars)[0] ?? "app",
        mount_path: fullMountPath,
        child_var: childVar,
        child_file: childFile ?? "",
        mount_type: "hono_route",
      };
      model.mounts.push(mount);
      localMounts.push(mount);

      if (childFile && existsSync(childFile)) {
        await this.parseFile(childFile, fullMountPath, inFlight, parsedCache, model);
      } else {
        model.skip_reasons.unresolved_import =
          (model.skip_reasons.unresolved_import ?? 0) + 1;
      }
    }
  }

  /** Detect Hono runtime from project files and source patterns. */
  private async detectRuntime(entryFile: string): Promise<HonoAppModel["runtime"]> {
    const dir = path.dirname(entryFile);
    const projectRoot = path.dirname(dir); // assume src/ is one level down
    // Check for wrangler.toml → Cloudflare Workers
    if (existsSync(path.join(projectRoot, "wrangler.toml")) ||
        existsSync(path.join(dir, "wrangler.toml"))) {
      return "cloudflare";
    }
    let source: string;
    try {
      source = await readFile(entryFile, "utf-8");
    } catch {
      return "unknown";
    }
    if (source.includes("Deno.serve")) return "deno";
    if (source.includes("Bun.serve")) return "bun";
    if (source.includes("@hono/node-server") || source.includes("serve({ fetch")) return "node";
    if (source.includes("hono/aws-lambda") || source.includes("handle(")) return "lambda";
    return "unknown";
  }

  /**
   * Extract env bindings from:
   * 1. c.env.IDENTIFIER member accesses
   * 2. Destructuring: const { A, B } = c.env
   * 3. Bindings type literal from Hono<{ Bindings: {...} }> or createFactory<{ Bindings: {...} }>
   */
  private extractEnvBindings(
    root: Parser.SyntaxNode,
    source: string,
    model: HonoAppModel,
  ): void {
    const bindings = new Set<string>();

    // Pattern 1 & 2: Walk AST for c.env.X and const { X } = c.env
    const cursor = root.walk();
    walk(cursor, (node) => {
      // c.env.IDENTIFIER
      if (node.type === "member_expression") {
        const obj = node.childForFieldName("object");
        const prop = node.childForFieldName("property");
        if (obj?.type === "member_expression" && prop) {
          const innerObj = obj.childForFieldName("object");
          const innerProp = obj.childForFieldName("property");
          if (innerObj?.text === "c" && innerProp?.text === "env") {
            bindings.add(prop.text);
          }
        }
      }

      // const { DATABASE_URL, KV } = c.env
      if (node.type === "variable_declarator") {
        const nameNode = node.childForFieldName("name");
        const valueNode = node.childForFieldName("value");
        if (nameNode?.type === "object_pattern" && valueNode?.type === "member_expression") {
          const obj = valueNode.childForFieldName("object");
          const prop = valueNode.childForFieldName("property");
          if (obj?.text === "c" && prop?.text === "env") {
            for (const child of nameNode.namedChildren) {
              if (child.type === "shorthand_property_identifier_pattern" ||
                  child.type === "shorthand_property_identifier") {
                bindings.add(child.text);
              }
              if (child.type === "pair_pattern") {
                const key = child.childForFieldName("key");
                if (key) bindings.add(key.text);
              }
            }
          }
        }
      }
    });

    // Pattern 3: Bindings type literal from source using regex (simpler than full AST type resolution)
    const bindingsMatch = source.match(/Bindings\s*:\s*\{([^}]+)\}/);
    if (bindingsMatch?.[1]) {
      const typeBody = bindingsMatch[1];
      const propRegex = /(\w+)\s*:/g;
      let m: RegExpExecArray | null;
      while ((m = propRegex.exec(typeBody)) !== null) {
        if (m[1]) bindings.add(m[1]);
      }
    }

    model.env_bindings = [...bindings].sort();
  }
}

// --- Utility functions ---

function pickLanguage(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".tsx") return "tsx";
  if (ext === ".ts") return "typescript";
  if (ext === ".jsx" || ext === ".js") return "javascript";
  return "typescript";
}

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
 * Detect `<parentVar>.basePath("/prefix")` call expression.
 * Returns the parent variable name and prefix path, or null.
 */
function extractBasePathCall(
  valueNode: Parser.SyntaxNode,
  knownVars: Record<string, HonoApp>,
): { parentVar: string; prefix: string } | null {
  if (valueNode.type !== "call_expression") return null;
  const fnNode = valueNode.childForFieldName("function");
  if (!fnNode || fnNode.type !== "member_expression") return null;
  const obj = fnNode.childForFieldName("object");
  const prop = fnNode.childForFieldName("property");
  if (!obj || !prop || obj.type !== "identifier") return null;
  if (prop.text !== "basePath") return null;
  if (!knownVars[obj.text]) return null;

  const argsNode = valueNode.childForFieldName("arguments");
  const firstArg = argsNode?.namedChildren[0];
  if (!firstArg) return null;
  const prefix = stringLiteralValue(firstArg);
  if (prefix == null) return null;

  // Combine parent's base_path with the new prefix
  const parentBase = knownVars[obj.text]?.base_path || "";
  return { parentVar: obj.text, prefix: joinPaths(parentBase, prefix) };
}

/**
 * Parse regex constraints from Hono path parameters.
 * e.g., ":id{[0-9]+}" → { id: "[0-9]+" }
 */
function parseRegexConstraints(
  rawPath: string,
): Record<string, string> | undefined {
  const regex = /:(\w+)\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  const constraints: Record<string, string> = {};
  let found = false;
  while ((match = regex.exec(rawPath)) !== null) {
    if (match[1] && match[2]) {
      constraints[match[1]] = match[2];
      found = true;
    }
  }
  return found ? constraints : undefined;
}

/** Check if a value is `createFactory(...)` or `createFactory<Env>(...)`. */
function isCreateFactoryCall(valueNode: Parser.SyntaxNode): boolean {
  if (valueNode.type !== "call_expression") return false;
  const fn = valueNode.childForFieldName("function");
  if (!fn) return false;
  // createFactory<...>()
  if (fn.type === "identifier" && fn.text === "createFactory") return true;
  // hono/factory.createFactory<...>()
  if (fn.type === "member_expression") {
    const prop = fn.childForFieldName("property");
    if (prop?.text === "createFactory") return true;
  }
  return false;
}

/** Check if a value is `<factoryVar>.createApp()`. */
function isFactoryCreateApp(
  valueNode: Parser.SyntaxNode,
  factoryVars: Set<string>,
): boolean {
  if (valueNode.type !== "call_expression") return false;
  const fn = valueNode.childForFieldName("function");
  if (!fn || fn.type !== "member_expression") return false;
  const obj = fn.childForFieldName("object");
  const prop = fn.childForFieldName("property");
  if (!obj || !prop || obj.type !== "identifier") return false;
  return factoryVars.has(obj.text) && prop.text === "createApp";
}

function classifyAppCreation(
  valueNode: Parser.SyntaxNode,
): HonoApp["created_via"] | null {
  if (valueNode.type !== "new_expression") return null;
  const ctor = valueNode.childForFieldName("constructor");
  if (!ctor) return null;
  if (ctor.type === "identifier") {
    if (ctor.text === "Hono") return "new Hono";
    if (ctor.text === "OpenAPIHono") return "OpenAPIHono";
  }
  if (ctor.type === "member_expression") {
    const prop = ctor.childForFieldName("property");
    if (prop?.text === "Hono") return "new Hono";
    if (prop?.text === "OpenAPIHono") return "OpenAPIHono";
  }
  return null;
}

function stringLiteralValue(node: Parser.SyntaxNode): string | null {
  if (node.type === "string") {
    const text = node.text;
    if (text.length < 2) return null;
    const quote = text[0];
    if (quote !== '"' && quote !== "'") return null;
    try {
      const normalized =
        quote === "'"
          ? `"${text.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`
          : text;
      const parsed: unknown = JSON.parse(normalized);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (node.type === "template_string") {
    const hasInterpolation = node.namedChildren.some(
      (c) => c.type === "template_substitution",
    );
    if (hasInterpolation) return null;
    const text = node.text;
    if (text.length < 2) return null;
    return text.slice(1, -1);
  }
  return null;
}

function buildHandler(node: Parser.SyntaxNode, file: string): HonoHandler {
  const line = node.startPosition.row + 1;
  if (
    node.type === "arrow_function" ||
    node.type === "function_expression" ||
    node.type === "function"
  ) {
    return { name: "<inline>", inline: true, file, line };
  }
  if (node.type === "identifier") {
    return { name: node.text, inline: false, file, line };
  }
  return { name: "<inline>", inline: true, file, line };
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
    if (existsSync(candidate)) {
      return canonicalize(candidate);
    }
  }
  return null;
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

/** Join a parent prefix with a child path, avoiding double/trailing slashes. */
function joinPaths(prefix: string, childPath: string): string {
  if (!prefix) return childPath;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  // In Hono, a sub-router's "/" matches the mount path exactly (no trailing slash)
  if (childPath === "/" || childPath === "") return p || "/";
  const c = childPath.startsWith("/") ? childPath : "/" + childPath;
  return p + c;
}

/**
 * Given the `consequence` of an if_statement, locate a middleware-call
 * expression of the form `mw(c, next)`. Walks the whole block (not just the
 * first statement) so patterns like
 *
 *     if (cond) {
 *       const auth = basicAuth({...});
 *       return auth(c, next);
 *     }
 *
 * are recognized. Only looks at top-level statements of the consequence —
 * does not descend into nested blocks. The candidate call must have >= 2
 * named arguments to heuristically match `mw(c, next)` shape.
 */
function findMiddlewareCallInBlock(
  consequence: Parser.SyntaxNode,
): Parser.SyntaxNode | null {
  const statements =
    consequence.type === "statement_block"
      ? consequence.namedChildren
      : [consequence];
  for (const stmt of statements) {
    let call: Parser.SyntaxNode | null = null;
    if (stmt.type === "return_statement") {
      const expr = stmt.namedChildren[0];
      if (expr) call = unwrapCallExpression(expr);
    } else if (stmt.type === "expression_statement") {
      const expr = stmt.namedChildren[0];
      if (expr) call = unwrapCallExpression(expr);
    }
    if (call && callHasAtLeastNArgs(call, 2)) return call;
  }
  return null;
}

function callHasAtLeastNArgs(
  call: Parser.SyntaxNode,
  n: number,
): boolean {
  const args = call.childForFieldName("arguments");
  return (args?.namedChildren.length ?? 0) >= n;
}

/**
 * Collect block-local alias declarations of the form
 *   const X = <callee>(...)
 * into a Map<X, <callee>>. Used to resolve `const auth = basicAuth({...})` so
 * that `return auth(c, next)` reports "basicAuth" as the applied middleware.
 */
function collectLocalAliases(
  consequence: Parser.SyntaxNode,
): Map<string, string> {
  const map = new Map<string, string>();
  const statements =
    consequence.type === "statement_block"
      ? consequence.namedChildren
      : [consequence];
  for (const stmt of statements) {
    if (stmt.type !== "lexical_declaration" && stmt.type !== "variable_declaration") continue;
    for (const declarator of stmt.namedChildren) {
      if (declarator.type !== "variable_declarator") continue;
      const nameNode = declarator.childForFieldName("name");
      const valueNode = declarator.childForFieldName("value");
      if (nameNode?.type !== "identifier" || !valueNode) continue;
      if (valueNode.type !== "call_expression") continue;
      const calleeName = extractCallCalleeName(valueNode);
      if (calleeName) map.set(nameNode.text, calleeName);
    }
  }
  return map;
}

/** Peel off `await ...` wrappers and return the underlying call_expression, if any. */
function unwrapCallExpression(
  node: Parser.SyntaxNode,
): Parser.SyntaxNode | null {
  let current = node;
  while (current.type === "await_expression") {
    const inner = current.namedChildren[0];
    if (!inner) return null;
    current = inner;
  }
  if (current.type === "call_expression") return current;
  return null;
}

/**
 * Extract the name of the middleware at the call site. Supports:
 *   - `foo(c, next)` → "foo"
 *   - `foo.bar(c, next)` → "bar"
 *   - `auth(c, next)` where `auth` came from `const auth = basicAuth({...})`
 *     → returns "auth"; T4 reports the local identifier, and a separate
 *     def-use pass could resolve it further (out of scope here).
 *   - `basicAuth({...})(c, next)` → "basicAuth" (outer callee of the inner call)
 */
function extractCallCalleeName(callNode: Parser.SyntaxNode): string | null {
  const fn = callNode.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "member_expression") {
    const prop = fn.childForFieldName("property");
    return prop?.text ?? null;
  }
  // `basicAuth({...})(c, next)` — fn itself is a call_expression
  if (fn.type === "call_expression") {
    const innerFn = fn.childForFieldName("function");
    if (innerFn?.type === "identifier") return innerFn.text;
    if (innerFn?.type === "member_expression") {
      const prop = innerFn.childForFieldName("property");
      return prop?.text ?? null;
    }
  }
  return null;
}

/**
 * Classify an if-condition into method / header / path / custom by looking at
 * the leftmost member_expression chain. Keeps the check cheap and deterministic.
 */
function classifyConditionType(
  condition: Parser.SyntaxNode,
): ConditionalApplication["condition_type"] {
  const text = condition.text;
  // Normalize for substring checks
  if (/c\.req\.method\b/.test(text)) return "method";
  if (/c\.req\.header\s*\(/.test(text) || /c\.req\.headers\b/.test(text)) return "header";
  if (/c\.req\.path\b/.test(text) || /c\.req\.url\b/.test(text)) return "path";
  return "custom";
}

/** Check if a node is inside a conditional branch (if/switch/try body). */
function isInsideBranch(node: Parser.SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "if_statement" ||
        current.type === "switch_case" ||
        current.type === "catch_clause" ||
        current.type === "ternary_expression") {
      return true;
    }
    // Stop at function boundary — we only care about branches within the function
    if (current.type === "arrow_function" ||
        current.type === "function_declaration" ||
        current.type === "function_expression" ||
        current.type === "method_definition") {
      break;
    }
    current = current.parent;
  }
  return false;
}

const MAX_WALK_DEPTH = 500;
type CursorVisitor = (node: Parser.SyntaxNode) => void;
function walk(
  cursor: Parser.TreeCursor,
  visit: CursorVisitor,
  depth = 0,
): void {
  if (depth > MAX_WALK_DEPTH) return;
  visit(cursor.currentNode);
  if (cursor.gotoFirstChild()) {
    do {
      walk(cursor, visit, depth + 1);
    } while (cursor.gotoNextSibling());
    cursor.gotoParent();
  }
}
