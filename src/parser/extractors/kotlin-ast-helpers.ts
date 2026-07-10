import type Parser from "web-tree-sitter";
import { getNodeName } from "./_shared.js";
// --- Helpers ---

/**
 * Gets the name from a Kotlin AST node.
 * Falls back to first `identifier` child when `childForFieldName("name")` returns null
 * (needed for enum_entry, class_parameter, type_alias, etc.).
 */
export function getName(node: Parser.SyntaxNode): string | null {
  return getNodeName(node)
    ?? node.namedChildren.find((c) => c.type === "identifier")?.text
    ?? null;
}

/**
 * Collects KDoc comment (/** ... *​/) immediately preceding a declaration.
 * In tree-sitter-kotlin, KDoc appears as `block_comment` starting with `/**`.
 * Always checks the declaration node's previousNamedSibling (not modifiers).
 */
export function getDocstring(
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
export function isInterface(node: Parser.SyntaxNode): boolean {
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
export function hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
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
export function getKmpModifier(node: Parser.SyntaxNode): "expect" | "actual" | null {
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

function getSimpleUserTypeName(node: Parser.SyntaxNode): string {
  const identifiers: string[] = [];
  function collect(current: Parser.SyntaxNode): void {
    if (current.type === "identifier") identifiers.push(current.text);
    for (const child of current.namedChildren) collect(child);
  }
  collect(node);
  return (identifiers.at(-1) ?? node.text.split(".").at(-1) ?? node.text)
    .trim()
    .replace(/^`|`$/g, "");
}

/**
 * Gets annotation names from a node's modifiers.
 * Annotation structure: modifiers → annotation → @ + user_type → identifier
 */
export function getAnnotations(node: Parser.SyntaxNode): string[] {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return [];

  return mods.namedChildren
    .filter((m) => m.type === "annotation")
    .map((a) => {
      const userType = a.namedChildren.find((c) => c.type === "user_type");
      if (userType) {
        return getSimpleUserTypeName(userType);
      }
      // Fallback: constructor_invocation for annotations with args
      const ctorInvoc = a.namedChildren.find((c) => c.type === "constructor_invocation");
      if (ctorInvoc) {
        const ut = ctorInvoc.namedChildren.find((c) => c.type === "user_type");
        return ut ? getSimpleUserTypeName(ut) : a.text.replace(/^@/, "");
      }
      return a.text.replace(/^@/, "");
    });
}
/**
 * Gets the name of a property_declaration (stored in variable_declaration/identifier).
 */
export function getPropertyName(node: Parser.SyntaxNode): string | null {
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
export function getSignature(
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
