import type { Node as TSNode } from "web-tree-sitter";

export type PhpDocTag = {
  tag: "property" | "method";
  name: string;
  type?: string;
};

/** Parse Yii-style magic property and method tags from a PHPDoc block. */
export function parsePhpDocTags(docstring?: string): PhpDocTag[] {
  if (!docstring) return [];
  const results: PhpDocTag[] = [];

  const propertyPattern = /@property(?:-read|-write)?\s+(\S+)\s+\$(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = propertyPattern.exec(docstring)) !== null) {
    results.push({ tag: "property", name: match[2]!, type: match[1]! });
  }

  const methodPattern = /@method\s+(?:(\S+)\s+)?(\w+)\s*\(/g;
  while ((match = methodPattern.exec(docstring)) !== null) {
    const entry: PhpDocTag = { tag: "method", name: match[2]! };
    if (match[1]) entry.type = match[1];
    results.push(entry);
  }

  return results;
}

/** Extract the raw type from the first `@var T` annotation. */
export function parsePhpDocVar(docstring?: string): string | undefined {
  if (!docstring) return undefined;
  const match = /@var\s+(\S+)/.exec(docstring);
  return match?.[1];
}

/** Return a contiguous leading PHPDoc comment for a declaration. */
export function getDocstring(node: TSNode, source: string): string | undefined {
  let previous = node.previousNamedSibling;
  while (
    previous &&
    (previous.type === "visibility_modifier" || previous.type === "attribute_list")
  ) {
    previous = previous.previousNamedSibling;
  }
  if (!previous || previous.type !== "comment") return undefined;

  const text = source.slice(previous.startIndex, previous.endIndex);
  return text.startsWith("/**") ? text : undefined;
}
