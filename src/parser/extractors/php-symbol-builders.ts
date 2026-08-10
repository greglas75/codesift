import type { Node as TSNode } from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { makeSymbol } from "./_shared.js";
import { parsePhpDocTags } from "./php-doc.js";
import { collectModifiers, getInlineType, parseAttributes } from "./php-node-metadata.js";

export type PhpExtractionContext = {
  symbols: CodeSymbol[];
  filePath: string;
  source: string;
  repo: string;
};

function comparableMemberName(name: string, kind: SymbolKind): string {
  return kind === "field" ? name.replace(/^\$/, "") : name.toLowerCase();
}

/** Add Yii-style docblock members unless a real member already exists. */
export function synthesizeDocstringTags(
  context: PhpExtractionContext,
  node: TSNode,
  parent: CodeSymbol,
  docstring: string | undefined,
): void {
  if (!docstring) return;
  for (const tag of parsePhpDocTags(docstring)) {
    const targetKind: SymbolKind = tag.tag === "property" ? "field" : "method";
    const memberExists = context.symbols.some(
      (symbol) =>
        symbol.parent === parent.id &&
        comparableMemberName(symbol.name, symbol.kind) ===
          comparableMemberName(tag.name, targetKind) &&
        symbol.kind === targetKind,
    );
    if (memberExists) continue;

    const options: {
      parentId: string;
      signature?: string;
      meta: Record<string, unknown>;
    } = {
      parentId: parent.id,
      meta: { synthetic: true },
    };
    if (tag.type) options.signature = tag.type;
    context.symbols.push(
      makeSymbol(
        node,
        tag.name,
        targetKind,
        context.filePath,
        context.source,
        context.repo,
        options,
      ),
    );
  }
}

/** Add fields represented only by PHP 8 promoted constructor parameters. */
export function emitPromotedConstructorFields(
  context: PhpExtractionContext,
  methodNode: TSNode,
  classId: string,
): void {
  const parameters =
    methodNode.childForFieldName("parameters") ??
    methodNode.namedChildren.find((child) => child.type === "formal_parameters");
  if (!parameters) return;

  for (const parameter of parameters.namedChildren) {
    if (parameter.type !== "property_promotion_parameter") continue;
    const variable = parameter.namedChildren.find((child) => child.type === "variable_name");
    const name = variable?.namedChildren.find((child) => child.type === "name");
    if (!name) continue;

    const modifiers = collectModifiers(parameter);
    const inlineType = getInlineType(parameter);
    const attributes = parseAttributes(parameter);
    const meta: Record<string, unknown> = { from_constructor: true };
    if (modifiers.visibility) meta.visibility = modifiers.visibility;
    if (modifiers.is_readonly) meta.is_readonly = true;
    if (inlineType) {
      meta.type = inlineType;
      meta.type_source = "inline";
    }
    if (attributes.length > 0) meta.attributes = attributes;

    context.symbols.push(
      makeSymbol(
        parameter,
        `$${name.text}`,
        "field",
        context.filePath,
        context.source,
        context.repo,
        { parentId: classId, meta },
      ),
    );
  }
}
