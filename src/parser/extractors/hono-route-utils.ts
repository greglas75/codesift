import type Parser from "web-tree-sitter";
import type { HonoHandler } from "./hono-model.js";

/**
 * Parse regex constraints from Hono path parameters.
 * e.g., ":id{[0-9]+}" -> { id: "[0-9]+" }
 */
export function parseRegexConstraints(
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

export function buildHandler(
  node: Parser.SyntaxNode,
  file: string,
): HonoHandler {
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

/** Join a parent prefix with a child path, avoiding double/trailing slashes. */
export function joinPaths(prefix: string, childPath: string): string {
  if (!prefix) return childPath;
  const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (childPath === "/" || childPath === "") return normalizedPrefix || "/";
  const normalizedChild = childPath.startsWith("/") ? childPath : "/" + childPath;
  return normalizedPrefix + normalizedChild;
}
