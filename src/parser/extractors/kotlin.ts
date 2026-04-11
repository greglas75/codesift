import type Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { getNodeName, makeSymbol } from "./_shared.js";

// --- Helpers ---

/**
 * Gets the name from a Kotlin AST node.
 * Falls back to first `identifier` child when `childForFieldName("name")` returns null
 * (needed for enum_entry, class_parameter, type_alias, etc.).
 */
function getName(node: Parser.SyntaxNode): string | null {
  return getNodeName(node)
    ?? node.namedChildren.find((c) => c.type === "identifier")?.text
    ?? null;
}

/**
 * Collects KDoc comment (/** ... *​/) immediately preceding a declaration.
 * In tree-sitter-kotlin, KDoc appears as `block_comment` starting with `/**`.
 * Always checks the declaration node's previousNamedSibling (not modifiers).
 */
function getDocstring(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  const prev = node.previousNamedSibling;
  if (!prev || prev.type !== "block_comment") return undefined;

  const text = source.slice(prev.startIndex, prev.endIndex);
  if (!text.startsWith("/**")) return undefined;
  return text;
}

/**
 * Checks if a class_declaration has the `interface` keyword (unnamed child).
 */
function isInterface(node: Parser.SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === "interface") return true;
    // Stop once we hit the identifier or class_body
    if (child && (child.type === "identifier" || child.type === "class_body")) break;
  }
  return false;
}

/**
 * Checks if modifiers contain a specific modifier keyword.
 * Works with class_modifier, function_modifier, property_modifier, inheritance_modifier.
 */
function hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return false;

  // Walk recursively through modifier tree to find the keyword
  function findMod(n: Parser.SyntaxNode): boolean {
    if (n.text === modifier && !n.isNamed) return true;
    if (n.isNamed && n.text === modifier) return true;
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child && findMod(child)) return true;
    }
    return false;
  }

  return findMod(mods);
}

/**
 * Detects KMP platform modifiers (expect / actual). The Kotlin grammar
 * surfaces these as `platform_modifier` nodes inside `modifiers`. Returns
 * "expect", "actual", or null.
 */
function getKmpModifier(node: Parser.SyntaxNode): "expect" | "actual" | null {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return null;
  for (const m of mods.namedChildren) {
    if (m.type !== "platform_modifier") continue;
    const text = m.text.trim();
    if (text === "expect") return "expect";
    if (text === "actual") return "actual";
  }
  return null;
}

/**
 * Gets annotation names from a node's modifiers.
 * Annotation structure: modifiers → annotation → @ + user_type → identifier
 */
function getAnnotations(node: Parser.SyntaxNode): string[] {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return [];

  return mods.namedChildren
    .filter((m) => m.type === "annotation")
    .map((a) => {
      const userType = a.namedChildren.find((c) => c.type === "user_type");
      if (userType) {
        const ident = userType.namedChildren.find((c) => c.type === "identifier");
        return ident?.text ?? userType.text;
      }
      // Fallback: constructor_invocation for annotations with args
      const ctorInvoc = a.namedChildren.find((c) => c.type === "constructor_invocation");
      if (ctorInvoc) {
        const ut = ctorInvoc.namedChildren.find((c) => c.type === "user_type");
        const ident = ut?.namedChildren.find((c) => c.type === "identifier");
        return ident?.text ?? ut?.text ?? a.text.replace(/^@/, "");
      }
      return a.text.replace(/^@/, "");
    });
}

const TEST_ANNOTATIONS = new Set(["Test", "ParameterizedTest", "RepeatedTest"]);
const HOOK_ANNOTATIONS = new Set([
  "BeforeEach", "AfterEach", "BeforeAll", "AfterAll",
  "Before", "After", "BeforeClass", "AfterClass",
]);

/**
 * Kotest spec superclasses. A class extending any of these becomes a
 * `test_suite` and its constructor-argument lambda body is walked to find
 * DSL test declarations.
 */
const KOTEST_SPEC_CLASSES = new Set([
  "FunSpec", "DescribeSpec", "StringSpec", "BehaviorSpec",
  "ShouldSpec", "WordSpec", "FeatureSpec", "ExpectSpec",
  "AnnotationSpec", "FreeSpec",
]);

/**
 * Kotest DSL call identifiers that mark a `test_case`. Each appears as the
 * callee of a `call_expression` in the spec body (e.g. `test("name") { ... }`,
 * `it("name") { ... }`, `describe("name") { ... }`).
 */
const KOTEST_DSL_KEYWORDS = new Set([
  "test", "it", "describe", "context", "should",
  "given", "when", "then", "feature", "scenario", "expect",
  "xtest", "xit", "xdescribe", "xcontext", // skipped variants
]);

/**
 * Detects whether a class extends a Kotest spec via `delegation_specifiers`.
 * Returns the `lambda_literal` node inside the spec's constructor call so the
 * caller can walk it for DSL test declarations. Returns null if the class
 * doesn't extend a Kotest spec.
 */
function findKotestSpecLambda(
  node: Parser.SyntaxNode,
): Parser.SyntaxNode | null {
  const delegation = node.namedChildren.find(
    (c) => c.type === "delegation_specifiers",
  );
  if (!delegation) return null;

  for (const spec of delegation.namedChildren) {
    if (spec.type !== "delegation_specifier") continue;
    const ctor = spec.namedChildren.find(
      (c) => c.type === "constructor_invocation",
    );
    if (!ctor) continue;
    const userType = ctor.namedChildren.find((c) => c.type === "user_type");
    if (!userType) continue;
    const ident = userType.namedChildren.find((c) => c.type === "identifier");
    if (!ident || !KOTEST_SPEC_CLASSES.has(ident.text)) continue;

    const valueArgs = ctor.namedChildren.find(
      (c) => c.type === "value_arguments",
    );
    if (!valueArgs) return null;
    const valueArg = valueArgs.namedChildren.find(
      (c) => c.type === "value_argument",
    );
    if (!valueArg) return null;
    const lambda = valueArg.namedChildren.find(
      (c) => c.type === "lambda_literal",
    );
    return lambda ?? null;
  }
  return null;
}

/**
 * Extracts a Kotest DSL test name from a `call_expression` node. Returns the
 * string literal argument for the two recognized patterns and null otherwise.
 *
 * Pattern A (FunSpec/DescribeSpec/BehaviorSpec): `test("name") { ... }` —
 *   AST: call_expression > [call_expression(identifier=keyword, value_arguments(string)), annotated_lambda]
 *
 * Pattern B (StringSpec): `"name" { ... }` —
 *   AST: call_expression > [string_literal, annotated_lambda]
 */
function extractKotestTestName(
  call: Parser.SyntaxNode,
): string | null {
  // Must have an annotated_lambda child to be a DSL test declaration with body.
  const hasLambda = call.namedChildren.some(
    (c) => c.type === "annotated_lambda",
  );
  if (!hasLambda) return null;

  // Pattern B: StringSpec inline — first child is a string_literal.
  const firstChild = call.namedChildren[0];
  if (firstChild && firstChild.type === "string_literal") {
    return unquoteStringLiteral(firstChild);
  }

  // Pattern A: inner call_expression with DSL keyword as callee.
  if (firstChild && firstChild.type === "call_expression") {
    const callee = firstChild.namedChildren.find(
      (c) => c.type === "identifier",
    );
    if (!callee) return null;
    // Strip backticks from escaped identifiers (e.g. `when`).
    const keyword = callee.text.replace(/^`|`$/g, "");
    if (!KOTEST_DSL_KEYWORDS.has(keyword)) return null;

    const args = firstChild.namedChildren.find(
      (c) => c.type === "value_arguments",
    );
    if (!args) return null;
    const firstArg = args.namedChildren.find((c) => c.type === "value_argument");
    if (!firstArg) return null;
    const strLit = firstArg.namedChildren.find(
      (c) => c.type === "string_literal",
    );
    if (!strLit) return null;
    return unquoteStringLiteral(strLit);
  }

  return null;
}

function unquoteStringLiteral(node: Parser.SyntaxNode): string {
  // Prefer the inner string_content child when present (avoids the outer quotes).
  const content = node.namedChildren.find((c) => c.type === "string_content");
  if (content) return content.text;
  // Fallback: strip surrounding quotes from raw text.
  return node.text.replace(/^"|"$/g, "");
}

/**
 * Walks a Kotest DSL lambda body and emits a `test_case` symbol for each
 * recognized call_expression (test/it/describe/etc.). Recurses into nested
 * DSL lambdas so given → when → then / describe → it produces one symbol per
 * level.
 */
function walkKotestLambda(
  lambda: Parser.SyntaxNode,
  parentId: string,
  filePath: string,
  source: string,
  repo: string,
  symbols: CodeSymbol[],
): void {
  for (const child of lambda.namedChildren) {
    if (child.type !== "call_expression") {
      // Recurse into blocks that may contain more DSL calls.
      for (const grand of child.namedChildren) {
        if (grand.type === "call_expression") {
          walkKotestCall(grand, parentId, filePath, source, repo, symbols);
        }
      }
      continue;
    }
    walkKotestCall(child, parentId, filePath, source, repo, symbols);
  }
}

function walkKotestCall(
  call: Parser.SyntaxNode,
  parentId: string,
  filePath: string,
  source: string,
  repo: string,
  symbols: CodeSymbol[],
): void {
  const testName = extractKotestTestName(call);
  if (!testName) return;

  const sym = makeSymbol(call, testName, "test_case", filePath, source, repo, {
    parentId,
  });
  symbols.push(sym);

  // Recurse into the annotated_lambda body so nested DSL levels produce
  // their own test_case symbols.
  const annotatedLambda = call.namedChildren.find(
    (c) => c.type === "annotated_lambda",
  );
  if (!annotatedLambda) return;
  const innerLambda = annotatedLambda.namedChildren.find(
    (c) => c.type === "lambda_literal",
  );
  if (!innerLambda) return;
  walkKotestLambda(innerLambda, sym.id, filePath, source, repo, symbols);
}

/**
 * Determines if a function is a test or test hook based on annotations.
 */
function getTestKind(node: Parser.SyntaxNode): SymbolKind | null {
  const annotations = getAnnotations(node);
  for (const ann of annotations) {
    if (TEST_ANNOTATIONS.has(ann)) return "test_case";
    if (HOOK_ANNOTATIONS.has(ann)) return "test_hook";
  }
  return null;
}

/**
 * Gets the name of a property_declaration (stored in variable_declaration/identifier).
 */
function getPropertyName(node: Parser.SyntaxNode): string | null {
  const varDecl = node.namedChildren.find((c) => c.type === "variable_declaration");
  if (varDecl) {
    const ident = varDecl.namedChildren.find((c) => c.type === "identifier");
    return ident?.text ?? null;
  }
  return null;
}

/**
 * Detects if a function_declaration is an extension function.
 * Extension functions have a user_type before the identifier with a "." between them.
 * Returns the receiver type name or null.
 */
function getReceiverType(
  node: Parser.SyntaxNode,
  source: string,
): string | null {
  const nameNode = node.childForFieldName("name")
    ?? node.namedChildren.find((c) => c.type === "identifier");
  if (!nameNode) return null;

  // Look for user_type that appears BEFORE the function name
  for (const child of node.namedChildren) {
    if (child.type === "user_type" && child.endIndex < nameNode.startIndex) {
      return source.slice(child.startIndex, child.endIndex);
    }
  }
  return null;
}

/**
 * Extracts function signature: parameter list + return type.
 * For Kotlin: `(name: String, age: Int): User?`
 */
function getSignature(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  const params = node.namedChildren.find(
    (c) => c.type === "function_value_parameters",
  );
  if (!params) return undefined;

  let sig = "";

  // Prefix with suspend if present
  if (hasModifier(node, "suspend")) {
    sig += "suspend ";
  }

  // Include receiver type for extension functions
  const receiver = getReceiverType(node, source);
  if (receiver) {
    sig += receiver + ".";
  }

  // Type parameters (generics)
  const typeParams = node.namedChildren.find(
    (c) => c.type === "type_parameters",
  );
  if (typeParams) {
    sig += source.slice(typeParams.startIndex, typeParams.endIndex) + " ";
  }

  sig += source.slice(params.startIndex, params.endIndex);

  // Return type: find user_type / nullable_type / function_type AFTER params
  for (const child of node.namedChildren) {
    if (
      child.startIndex > params.endIndex &&
      (child.type === "user_type" ||
        child.type === "nullable_type" ||
        child.type === "function_type" ||
        child.type === "parenthesized_type")
    ) {
      sig += ": " + source.slice(child.startIndex, child.endIndex);
      break;
    }
  }

  return sig.trim() || undefined;
}

// --- Main extractor ---

export function extractKotlinSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  function walk(node: Parser.SyntaxNode, parentId?: string): void {
    switch (node.type) {
      case "function_declaration": {
        const name = getName(node);
        if (name) {
          const testKind = getTestKind(node);
          const annotations = getAnnotations(node);
          const isComposable = annotations.includes("Composable");
          const isPreview = annotations.includes("Preview");
          const kind: SymbolKind = testKind
            ?? (isComposable ? "component" : (parentId ? "method" : "function"));
          const kmp = getKmpModifier(node);

          // Build meta — merge KMP, Compose, and Preview flags.
          const meta: Record<string, unknown> = {};
          if (kmp) meta["kmp_modifier"] = kmp;
          if (isComposable) meta["compose"] = true;
          if (isPreview) meta["compose_preview"] = true;

          const sym = makeSymbol(node, name, kind, filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            signature: getSignature(node, source),
            decorators: annotations.length > 0 ? annotations : undefined,
            meta: Object.keys(meta).length > 0 ? meta : undefined,
          });
          symbols.push(sym);
        }
        break;
      }

      case "class_declaration": {
        const name = getName(node);
        if (name) {
          // Distinguish interface from class by checking for unnamed `interface` keyword
          const kotestLambda = findKotestSpecLambda(node);
          const baseKind: SymbolKind = isInterface(node) ? "interface" : "class";
          const kind: SymbolKind = kotestLambda ? "test_suite" : baseKind;
          const annotations = getAnnotations(node);
          const kmp = getKmpModifier(node);
          const sym = makeSymbol(node, name, kind, filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            decorators: annotations.length > 0 ? annotations : undefined,
            meta: kmp ? { kmp_modifier: kmp } : undefined,
          });
          symbols.push(sym);

          // Walk Kotest DSL body for test_case symbols (FunSpec/DescribeSpec/etc.).
          if (kotestLambda) {
            walkKotestLambda(kotestLambda, sym.id, filePath, source, repo, symbols);
          }

          // Extract primary constructor val/var params as fields
          const primaryCtor = node.namedChildren.find(
            (c) => c.type === "primary_constructor",
          );
          if (primaryCtor) {
            const classParams = primaryCtor.namedChildren.find(
              (c) => c.type === "class_parameters",
            );
            if (classParams) {
              for (const param of classParams.namedChildren) {
                if (param.type === "class_parameter") {
                  const paramName = getName(param);
                  // Check for val/var keyword (unnamed child)
                  let hasValVar = false;
                  for (let i = 0; i < param.childCount; i++) {
                    const child = param.child(i);
                    if (
                      child &&
                      (child.type === "val" || child.type === "var")
                    ) {
                      hasValVar = true;
                      break;
                    }
                  }
                  if (paramName && hasValVar) {
                    const fieldSym = makeSymbol(
                      param,
                      paramName,
                      "field",
                      filePath,
                      source,
                      repo,
                      { parentId: sym.id },
                    );
                    symbols.push(fieldSym);
                  }
                }
              }
            }
          }

          // Extract enum entries
          const enumBody = node.namedChildren.find(
            (c) => c.type === "enum_class_body",
          );
          if (enumBody) {
            for (const entry of enumBody.namedChildren) {
              if (entry.type === "enum_entry") {
                const entryName = getName(entry);
                if (entryName) {
                  const entrySym = makeSymbol(
                    entry,
                    entryName,
                    "field",
                    filePath,
                    source,
                    repo,
                    { parentId: sym.id },
                  );
                  symbols.push(entrySym);
                }
              }
            }
          }

          // Walk class body for methods, nested classes, properties, etc.
          const classBody = node.namedChildren.find(
            (c) => c.type === "class_body" || c.type === "enum_class_body",
          );
          if (classBody) {
            for (const child of classBody.namedChildren) {
              walk(child, sym.id);
            }
          }
        }
        return; // Don't default-walk (handled above)
      }

      case "object_declaration": {
        const name = getName(node);
        if (name) {
          const annotations = getAnnotations(node);
          const sym = makeSymbol(node, name, "class", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            decorators: annotations.length > 0 ? annotations : undefined,
          });
          symbols.push(sym);

          const body = node.namedChildren.find(
            (c) => c.type === "class_body",
          );
          if (body) {
            for (const child of body.namedChildren) {
              walk(child, sym.id);
            }
          }
        }
        return;
      }

      case "companion_object": {
        const nameNode = node.namedChildren.find(
          (c) => c.type === "identifier",
        );
        const name = nameNode?.text ?? "Companion";
        const sym = makeSymbol(node, name, "class", filePath, source, repo, {
          parentId,
          docstring: getDocstring(node, source),
        });
        symbols.push(sym);

        const body = node.namedChildren.find(
          (c) => c.type === "class_body",
        );
        if (body) {
          for (const child of body.namedChildren) {
            walk(child, sym.id);
          }
        }
        return;
      }

      case "property_declaration": {
        const name = getPropertyName(node);
        if (name) {
          const isConst = hasModifier(node, "const");
          let kind: SymbolKind;
          if (isConst) {
            kind = "constant";
          } else if (parentId) {
            kind = "field";
          } else {
            kind = "variable";
          }
          const annotations = getAnnotations(node);
          const kmp = getKmpModifier(node);
          const sym = makeSymbol(node, name, kind, filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            decorators: annotations.length > 0 ? annotations : undefined,
            meta: kmp ? { kmp_modifier: kmp } : undefined,
          });
          symbols.push(sym);
        }
        break;
      }

      case "type_alias": {
        const name = getName(node);
        if (name) {
          const sym = makeSymbol(node, name, "type", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
          });
          symbols.push(sym);
        }
        break;
      }

      default:
        break;
    }

    // Default: walk children (only if we didn't return early)
    for (const child of node.namedChildren) {
      walk(child, parentId);
    }
  }

  walk(tree.rootNode);
  return symbols;
}
