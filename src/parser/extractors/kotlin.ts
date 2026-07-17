import type Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { makeSymbol } from "./_shared.js";
import {
  getAnnotations,
  getDocstring,
  getKmpModifier,
  getName,
  getPropertyName,
  getSignature,
  hasModifier,
  isInterface,
} from "./kotlin-ast-helpers.js";
import {
  findKotestSpecLambda,
  getTestKind,
  walkKotestLambda,
} from "./kotlin-test-symbols.js";
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
