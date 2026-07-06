import type Parser from "web-tree-sitter";
import type {
  ConditionalApplication,
  HonoApp,
  HonoAppModel,
  MiddlewareEntry,
} from "./hono-model.js";
import { stringLiteralValue, walk } from "./hono-ast-utils.js";

interface UseCall {
  ownerVar: string;
  argList: Parser.SyntaxNode[];
  line: number;
}

interface ScopeParse {
  scopes: string[];
  middlewareStartIndex: number;
}

interface BuiltEntries {
  entries: MiddlewareEntry[];
  nextOrder: number;
}

/**
 * Extracts app.use(...) middleware chains from a Hono AST.
 *
 * HonoExtractor owns file parsing and app-variable discovery; this module owns
 * the middleware-specific call shapes, combine expansion, spread arrays, and
 * conditional inline middleware detection.
 */
export class HonoMiddlewareExtractor {
  /**
   * Walk for app.use(scope, mw1, mw2, ...) calls.
   * Handles: identifiers, inline arrows, some()/every() from hono/combine,
   * spread arrays, call expressions like cors().
   */
  walkMiddleware(
    root: Parser.SyntaxNode,
    file: string,
    appVars: Record<string, HonoApp>,
    model: HonoAppModel,
  ): void {
    const arrayVars = this.collectArrayVars(root);
    const stringVars = this.collectStringVars(root);
    const importSources = this.collectImportSources(root);

    const cursor = root.walk();
    walk(cursor, (node) => {
      const useCall = this.readUseCall(node, appVars);
      if (!useCall) return;

      const { scopes, middlewareStartIndex } = this.readScope(
        useCall.argList,
        stringVars,
      );
      const entries = this.buildMiddlewareEntries(
        useCall.argList,
        middlewareStartIndex,
        file,
        useCall.line,
        arrayVars,
        importSources,
      );
      for (const scope of scopes) {
        this.mergeMiddlewareChain(model, scope, useCall.ownerVar, entries);
      }
    });
  }

  private readUseCall(
    node: Parser.SyntaxNode,
    appVars: Record<string, HonoApp>,
  ): UseCall | null {
    if (node.type !== "call_expression") return null;
    const fnNode = node.childForFieldName("function");
    const argsNode = node.childForFieldName("arguments");
    if (!fnNode || !argsNode || fnNode.type !== "member_expression") return null;

    const objectNode = fnNode.childForFieldName("object");
    const propertyNode = fnNode.childForFieldName("property");
    if (!objectNode || !propertyNode) return null;
    if (propertyNode.text !== "use") return null;
    const ownerVar = extractOwnerIdentifier(objectNode);
    if (!ownerVar || !appVars[ownerVar]) return null;

    const argList = argsNode.namedChildren;
    if (argList.length === 0) return null;
    return {
      ownerVar,
      argList,
      line: node.startPosition.row + 1,
    };
  }

  private readScope(
    argList: Parser.SyntaxNode[],
    stringVars: Map<string, string>,
  ): ScopeParse {
    const firstArg = argList[0];
    if (!firstArg) return { scopes: ["*"], middlewareStartIndex: 0 };

    if (firstArg.type === "array") {
      const scopes = firstArg.namedChildren
        .map((child) => stringLiteralValue(child))
        .filter((scope): scope is string => scope != null);
      return {
        scopes: scopes.length > 0 ? scopes : ["*"],
        middlewareStartIndex: 1,
      };
    }

    const maybeScope = stringLiteralValue(firstArg);
    if (maybeScope == null) {
      if (firstArg.type === "identifier") {
        const dynamicScope = stringVars.get(firstArg.text);
        if (dynamicScope) {
          return { scopes: [dynamicScope], middlewareStartIndex: 1 };
        }
      }
      return { scopes: ["*"], middlewareStartIndex: 0 };
    }
    return { scopes: [maybeScope], middlewareStartIndex: 1 };
  }

  private buildMiddlewareEntries(
    argList: Parser.SyntaxNode[],
    startIndex: number,
    file: string,
    useLine: number,
    arrayVars: Map<string, string[]>,
    importSources: Map<string, string>,
  ): MiddlewareEntry[] {
    const entries: MiddlewareEntry[] = [];
    let order = 0;

    for (let i = startIndex; i < argList.length; i++) {
      const arg = argList[i];
      if (!arg) continue;
      order++;

      const spreadEntries = this.expandSpreadMiddleware(
        arg,
        file,
        useLine,
        order,
        arrayVars,
        importSources,
      );
      if (spreadEntries) {
        entries.push(...spreadEntries.entries);
        order = spreadEntries.nextOrder;
        continue;
      }

      const combineEntries = this.expandCombineMiddleware(
        arg,
        file,
        order,
        importSources,
      );
      if (combineEntries) {
        entries.push(...combineEntries.entries);
        order = combineEntries.nextOrder;
        continue;
      }

      const middlewareName = this.extractMiddlewareName(arg);
      entries.push(this.buildMiddlewareEntry(
        middlewareName,
        file,
        arg.startPosition.row + 1,
        order,
        importSources,
        undefined,
      ));
      order = this.appendConditionalEntries(arg, file, order, importSources, entries);
    }
    return entries;
  }

  private expandSpreadMiddleware(
    arg: Parser.SyntaxNode,
    file: string,
    useLine: number,
    order: number,
    arrayVars: Map<string, string[]>,
    importSources: Map<string, string>,
  ): BuiltEntries | null {
    if (arg.type !== "spread_element") return null;
    const inner = arg.namedChildren[0];
    if (inner?.type !== "identifier") return { entries: [], nextOrder: order };

    const arrayItems = arrayVars.get(inner.text);
    if (!arrayItems) {
      const entry = this.buildMiddlewareEntry(
        `...${inner.text}`,
        file,
        useLine,
        order,
        importSources,
        undefined,
      );
      const importedFrom = importSources.get(inner.text);
      if (importedFrom) {
        entry.imported_from = importedFrom;
        entry.is_third_party = isThirdPartyImport(importedFrom);
      }
      return { entries: [entry], nextOrder: order + 1 };
    }

    const entries: MiddlewareEntry[] = [];
    let nextOrder = order;
    for (const item of arrayItems) {
      entries.push(this.buildMiddlewareEntry(
        item,
        file,
        useLine,
        nextOrder++,
        importSources,
        undefined,
      ));
    }
    return { entries, nextOrder };
  }

  private expandCombineMiddleware(
    arg: Parser.SyntaxNode,
    file: string,
    order: number,
    importSources: Map<string, string>,
  ): BuiltEntries | null {
    if (arg.type !== "call_expression") return null;
    const callFunction = arg.childForFieldName("function");
    const callArguments = arg.childForFieldName("arguments");
    const combineType = extractCombineType(callFunction);
    if (!combineType || !callArguments) return null;

    const entries: MiddlewareEntry[] = [];
    let nextOrder = order;
    for (const innerArg of callArguments.namedChildren) {
      entries.push(this.buildMiddlewareEntry(
        innerArg.type === "identifier" ? innerArg.text : "<inline>",
        file,
        innerArg.startPosition.row + 1,
        nextOrder++,
        importSources,
        combineType,
      ));
    }
    return { entries, nextOrder };
  }

  private appendConditionalEntries(
    arg: Parser.SyntaxNode,
    file: string,
    order: number,
    importSources: Map<string, string>,
    entries: MiddlewareEntry[],
  ): number {
    if (
      arg.type !== "arrow_function" &&
      arg.type !== "function_expression"
    ) {
      return order;
    }

    let nextOrder = order;
    for (const found of this.detectConditionalMiddlewareCalls(arg)) {
      nextOrder++;
      const extra = this.buildMiddlewareEntry(
        found.name,
        file,
        found.line,
        nextOrder,
        importSources,
        undefined,
      );
      extra.conditional = true;
      extra.applied_when = found.applied_when;
      entries.push(extra);
    }
    return nextOrder;
  }

  private mergeMiddlewareChain(
    model: HonoAppModel,
    scope: string,
    ownerVar: string,
    entries: MiddlewareEntry[],
  ): void {
    if (entries.length === 0) return;

    const existing = model.middleware_chains.find(
      (chain) => chain.scope === scope && chain.owner_var === ownerVar,
    );
    if (existing) {
      existing.entries.push(...entries);
      return;
    }

    model.middleware_chains.push({
      scope,
      scope_pattern: scope,
      owner_var: ownerVar,
      entries,
    });
  }

  /**
   * Walk an inline middleware arrow body and surface conditional calls of the
   * form `if (cond) return mw(c, next)` or `if (cond) await mw(c, next)`.
   */
  private detectConditionalMiddlewareCalls(
    fnNode: Parser.SyntaxNode,
  ): Array<{ name: string; line: number; applied_when: ConditionalApplication }> {
    const results: Array<{
      name: string;
      line: number;
      applied_when: ConditionalApplication;
    }> = [];
    const block = fnNode.childForFieldName("body");
    if (!block) return results;
    if (block.type !== "statement_block") return results;

    const cursor = block.walk();
    walk(cursor, (stmt) => {
      if (stmt.type !== "if_statement") return;
      const condition = stmt.childForFieldName("condition");
      const consequence = stmt.childForFieldName("consequence");
      if (!condition || !consequence) return;

      const localAliases = collectLocalAliases(consequence);
      const middlewareCall = findMiddlewareCallInBlock(consequence);
      if (!middlewareCall) return;

      const rawName = extractCallCalleeName(middlewareCall);
      if (!rawName) return;
      const name = localAliases.get(rawName) ?? rawName;

      results.push({
        name,
        line: middlewareCall.startPosition.row + 1,
        applied_when: {
          condition_type: classifyConditionType(condition),
          condition_text: condition.text.slice(0, 200),
        },
      });
    });
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
    const isThirdParty = !!importedFrom && isThirdPartyImport(importedFrom);
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

  /** Collect local array variable declarations: const chain = [authMw, tenantMw] */
  private collectArrayVars(root: Parser.SyntaxNode): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "variable_declarator") return;
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (!nameNode || !valueNode || nameNode.type !== "identifier") return;
      const arrayNode = unwrapArrayExpression(valueNode);
      if (!arrayNode) return;
      const items: string[] = [];
      for (const element of arrayNode.namedChildren) {
        if (element.type === "spread_element") {
          const inner = element.namedChildren[0];
          const spreadItems = inner?.type === "identifier"
            ? result.get(inner.text)
            : undefined;
          if (spreadItems) {
            items.push(...spreadItems);
            continue;
          }
        }
        items.push(this.extractMiddlewareName(element));
      }
      if (items.length > 0) result.set(nameNode.text, items);
    });
    return result;
  }

  /** Collect const scope values: const API_PREFIX = "/api/*" */
  private collectStringVars(root: Parser.SyntaxNode): Map<string, string> {
    const result = new Map<string, string>();
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "variable_declarator") return;
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (!nameNode || !valueNode || nameNode.type !== "identifier") return;
      const value = stringLiteralValue(valueNode);
      if (value != null) result.set(nameNode.text, value);
    });
    return result;
  }

  /** Collect import source mapping: variableName -> packageSpecifier */
  private collectImportSources(root: Parser.SyntaxNode): Map<string, string> {
    const result = new Map<string, string>();
    const cursor = root.walk();
    walk(cursor, (node) => {
      if (node.type !== "import_statement") return;
      const sourceNode = node.childForFieldName("source");
      if (!sourceNode) return;
      const specifier = stringLiteralValue(sourceNode);
      if (!specifier) return;

      const importClause = node.children.find((child) => child.type === "import_clause");
      if (!importClause) return;
      for (const child of importClause.namedChildren) {
        if (child.type === "identifier") {
          result.set(child.text, specifier);
        }
        if (child.type === "named_imports") {
          for (const spec of child.namedChildren) {
            if (spec.type !== "import_specifier") continue;
            const alias = spec.childForFieldName("alias");
            const name = spec.childForFieldName("name");
            const varName = alias?.text ?? name?.text;
            if (varName) result.set(varName, specifier);
          }
        }
      }
    });
    return result;
  }
}

function isThirdPartyImport(importedFrom: string): boolean {
  if (importedFrom.startsWith(".") || importedFrom.startsWith("@/") ||
      importedFrom.startsWith("~/") || importedFrom.startsWith("src/") ||
      /^@(app|src|lib|core|shared|server|client)\//.test(importedFrom)) {
    return false;
  }
  return importedFrom.startsWith("hono/") || !importedFrom.startsWith(".");
}

function unwrapArrayExpression(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (current.type === "array") return current;
    if (
      current.type !== "as_expression" &&
      current.type !== "satisfies_expression" &&
      current.type !== "type_assertion" &&
      current.type !== "parenthesized_expression"
    ) {
      return null;
    }
    current = current.namedChildren[0] ?? null;
  }
  return null;
}

function extractOwnerIdentifier(node: Parser.SyntaxNode): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "member_expression") {
    const objectNode = node.childForFieldName("object");
    return objectNode ? extractOwnerIdentifier(objectNode) : null;
  }
  if (node.type === "call_expression") {
    const fnNode = node.childForFieldName("function");
    return fnNode ? extractOwnerIdentifier(fnNode) : null;
  }
  return null;
}

function extractCombineType(
  callFunction: Parser.SyntaxNode | null,
): "some" | "every" | null {
  if (callFunction?.type === "identifier" &&
      (callFunction.text === "some" || callFunction.text === "every")) {
    return callFunction.text;
  }
  if (callFunction?.type === "member_expression") {
    const property = callFunction.childForFieldName("property");
    if (property?.text === "some" || property?.text === "every") {
      return property.text;
    }
  }
  return null;
}

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

function extractCallCalleeName(callNode: Parser.SyntaxNode): string | null {
  const fn = callNode.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "member_expression") {
    const prop = fn.childForFieldName("property");
    return prop?.text ?? null;
  }
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

function classifyConditionType(
  condition: Parser.SyntaxNode,
): ConditionalApplication["condition_type"] {
  const text = condition.text;
  const contextRef = String.raw`(?:c|ctx|context)\.req`;
  if (new RegExp(`${contextRef}\\.method\\b`).test(text)) return "method";
  if (
    new RegExp(`${contextRef}\\.header\\s*\\(`).test(text) ||
    new RegExp(`${contextRef}\\.headers\\b`).test(text)
  ) {
    return "header";
  }
  if (
    new RegExp(`${contextRef}\\.path\\b`).test(text) ||
    new RegExp(`${contextRef}\\.url\\b`).test(text)
  ) {
    return "path";
  }
  return "custom";
}
