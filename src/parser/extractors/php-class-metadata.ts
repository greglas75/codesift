import type { Node as TSNode } from "web-tree-sitter";
import type { SymbolKind } from "../../types.js";

const TEST_BASE_NAMES = new Set(["TestCase", "Unit", "Cest", "Cept"]);

function parseClause(clause: TSNode | null, keyword: "extends" | "implements"): string[] {
  if (!clause) return [];
  const names = clause.namedChildren
    .filter((child) => child.type === "name" || child.type === "qualified_name")
    .map((child) => child.text.trim())
    .filter(Boolean);
  if (names.length > 0) return names;

  const stripped = clause.text.replace(new RegExp(`^${keyword}\\s+`), "").trim();
  return stripped ? stripped.split(/\s*,\s*/).filter(Boolean) : [];
}

export function parseBaseClause(baseClause: TSNode | null): string[] {
  return parseClause(baseClause, "extends");
}

export function parseInterfaceClause(clause: TSNode | null): string[] {
  return parseClause(clause, "implements");
}

export function collectTraitUses(body: TSNode | null): string[] {
  if (!body) return [];
  const traits: string[] = [];
  for (const child of body.namedChildren) {
    if (child.type !== "use_declaration") continue;
    for (const candidate of child.namedChildren) {
      if (candidate.type !== "name" && candidate.type !== "qualified_name") continue;
      const traitName = candidate.text.trim();
      if (traitName) traits.push(traitName);
    }
  }
  return traits;
}

export function collectClassExtends(node: TSNode): string[] {
  const clause =
    node.childForFieldName("base_clause") ??
    node.namedChildren.find((child) => child.type === "base_clause") ??
    null;
  return parseBaseClause(clause);
}

export function collectClassImplements(node: TSNode): string[] {
  const clause =
    node.childForFieldName("class_interface_clause") ??
    node.namedChildren.find((child) => child.type === "class_interface_clause") ??
    null;
  return parseInterfaceClause(clause);
}

export function isTestCaseClass(node: TSNode): boolean {
  return collectClassExtends(node).some((baseName) => {
    const segments = baseName.split(/[\\\\]+/);
    const finalSegment = segments[segments.length - 1]!;
    return TEST_BASE_NAMES.has(finalSegment);
  });
}

export function classifyMethod(
  name: string,
  parentIsTest: boolean,
  docstring: string | undefined,
): SymbolKind {
  if (["setUp", "tearDown", "setUpBeforeClass", "tearDownAfterClass"].includes(name)) {
    return "test_hook";
  }
  if (parentIsTest && (name.startsWith("test") || docstring?.includes("@test"))) {
    return "test_case";
  }
  return "method";
}
