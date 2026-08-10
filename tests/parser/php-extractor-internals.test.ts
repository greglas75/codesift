import { describe, expect, it } from "vitest";
import type { Node as TSNode, Tree as TSTree } from "web-tree-sitter";
import type { CodeSymbol } from "../../src/types.js";
import {
  classifyMethod,
  collectClassExtends,
  collectClassImplements,
  collectTraitUses,
  isTestCaseClass,
  parseBaseClause,
  parseInterfaceClause,
} from "../../src/parser/extractors/php-class-metadata.js";
import { getDocstring } from "../../src/parser/extractors/php-doc.js";
import {
  buildPropertyMeta,
  collectModifiers,
  getInlineType,
  getPropertyEntries,
  getPropertyName,
  getPropertyNames,
  getSignature,
  parseAttributes,
} from "../../src/parser/extractors/php-node-metadata.js";
import {
  emitPromotedConstructorFields,
  type PhpExtractionContext,
  synthesizeDocstringTags,
} from "../../src/parser/extractors/php-symbol-builders.js";
import { extractPhpSymbols } from "../../src/parser/extractors/php-walker.js";

// Test level: small — pure helpers over deterministic in-memory AST fixtures.

type NodeFields = Record<string, TSNode | null>;

function astNode(
  type: string,
  text = "",
  namedChildren: TSNode[] = [],
  fields: NodeFields = {},
  previousNamedSibling: TSNode | null = null,
): TSNode {
  return {
    type,
    text,
    namedChildren,
    previousNamedSibling,
    startIndex: 0,
    endIndex: text.length,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: text.length },
    childForFieldName: (name: string) => fields[name] ?? null,
  } as unknown as TSNode;
}

function named(type: string, text: string): TSNode {
  return astNode(type, text);
}

function attribute(name?: string, args?: string): TSNode {
  const children: TSNode[] = [];
  if (name) children.push(named("name", name));
  if (args !== undefined) children.push(named("arguments", `(${args})`));
  return astNode("attribute", name ?? "", children);
}

function attributeList(children: TSNode[]): TSNode {
  return astNode("attribute_list", "", children);
}

function extractionContext(): PhpExtractionContext {
  return { symbols: [], filePath: "test.php", source: "fixture", repo: "test" };
}

function parentSymbol(): CodeSymbol {
  return {
    id: "test:test.php:Parent:1",
    repo: "test",
    name: "Parent",
    kind: "class",
    file: "test.php",
    start_line: 1,
    end_line: 1,
  };
}

describe("PHP class metadata helpers", () => {
  it("parses structured and flattened inheritance clauses", () => {
    const structured = astNode("base_clause", "extends Ignored", [
      named("name", "Base"),
      named("qualified_name", "\\Vendor\\Other"),
      named("comment", "ignored"),
    ]);
    expect(parseBaseClause(structured)).toEqual(["Base", "\\Vendor\\Other"]);
    expect(parseBaseClause(astNode("base_clause", "extends A, B"))).toEqual(["A", "B"]);
    expect(parseInterfaceClause(astNode("class_interface_clause", "implements X, Y"))).toEqual([
      "X",
      "Y",
    ]);
    expect(parseBaseClause(astNode("base_clause", "   "))).toEqual([]);
    expect(parseBaseClause(null)).toEqual([]);
  });

  it("collects only valid trait names and handles a missing body", () => {
    const use = astNode("use_declaration", "", [
      named("name", "Timestamped"),
      named("qualified_name", "Vendor\\Searchable"),
      named("name", ""),
      named("comment", "ignored"),
    ]);
    const body = astNode("declaration_list", "", [named("method_declaration", "m"), use]);
    expect(collectTraitUses(body)).toEqual(["Timestamped", "Vendor\\Searchable"]);
    expect(collectTraitUses(null)).toEqual([]);
  });

  it("reads clause fields and falls back to named children", () => {
    const base = astNode("base_clause", "extends Base", [named("name", "Base")]);
    const interfaces = astNode("class_interface_clause", "implements I", [named("name", "I")]);
    const fieldBacked = astNode("class_declaration", "", [], {
      base_clause: base,
      class_interface_clause: interfaces,
    });
    expect(collectClassExtends(fieldBacked)).toEqual(["Base"]);
    expect(collectClassImplements(fieldBacked)).toEqual(["I"]);

    const childBacked = astNode("class_declaration", "", [base, interfaces]);
    expect(collectClassExtends(childBacked)).toEqual(["Base"]);
    expect(collectClassImplements(childBacked)).toEqual(["I"]);
  });

  it("recognizes namespaced test bases and classifies all method categories", () => {
    const base = astNode("base_clause", "", [named("qualified_name", "Codeception\\Test\\Unit")]);
    expect(isTestCaseClass(astNode("class_declaration", "", [], { base_clause: base }))).toBe(true);
    expect(isTestCaseClass(astNode("class_declaration"))).toBe(false);
    expect(classifyMethod("setUp", false, undefined)).toBe("test_hook");
    expect(classifyMethod("testCreatesUser", true, undefined)).toBe("test_case");
    expect(classifyMethod("createsUser", true, "/** @test */")).toBe("test_case");
    expect(classifyMethod("helper", true, undefined)).toBe("method");
  });
});

describe("PHP node metadata helpers", () => {
  it("builds signatures with and without return types and rejects missing parameters", () => {
    const parameters = named("formal_parameters", "(int $id)");
    const returnType = Object.assign(named("primitive_type", "bool"), {
      startIndex: 9,
      endIndex: 13,
    });
    expect(getSignature(astNode("method", "", [], { parameters, return_type: returnType }), "(int $id)bool"))
      .toBe("(int $id): bool");
    expect(getSignature(astNode("method", "", [], { parameters }), "(int $id)"))
      .toBe("(int $id)");
    expect(getSignature(astNode("method"), "")).toBeUndefined();
  });

  it("collects direct and generic modifiers while ignoring invalid visibility", () => {
    const declaration = astNode("method", "", [
      named("visibility_modifier", "public"),
      named("static_modifier", "static"),
      named("modifier", "abstract"),
      named("modifier", "final"),
      named("modifier", "readonly"),
      named("visibility_modifier", "package"),
    ]);
    expect(collectModifiers(declaration)).toEqual({
      visibility: "public",
      is_static: true,
      is_abstract: true,
      is_final: true,
      is_readonly: true,
    });
  });

  it("parses preceding, nested, grouped, and direct attributes", () => {
    const grouped = astNode("attribute_group", "", [
      attribute("Route", "  '/users'  "),
      attribute(),
    ]);
    const previous = attributeList([grouped, named("comment", "ignored")]);
    const nested = attributeList([attribute("Entity")]);
    const declaration = astNode("class", "", [nested], {}, previous);
    expect(parseAttributes(declaration)).toEqual([
      { name: "Route", args: "'/users'" },
      { name: "Entity" },
    ]);
  });

  it("preserves source order for stacked preceding attribute lists", () => {
    const first = attributeList([attribute("First")]);
    const second = astNode("attribute_list", "", [attribute("Second")], {}, first);
    const declaration = astNode("class", "", [], {}, second);
    expect(parseAttributes(declaration)).toEqual([{ name: "First" }, { name: "Second" }]);
  });

  it("extracts property names and inline types across present and absent shapes", () => {
    const variable = astNode("variable_name", "$email", [named("name", "email")]);
    const property = astNode("property_element", "$email", [variable]);
    const secondVariable = astNode("variable_name", "$name", [named("name", "name")]);
    const secondProperty = astNode("property_element", "$name", [secondVariable]);
    expect(
      getPropertyEntries(astNode("property_declaration", "", [property, secondProperty])),
    ).toEqual([
      { name: "$email", node: property },
      { name: "$name", node: secondProperty },
    ]);
    expect(getPropertyNames(astNode("property_declaration", "", [property, secondProperty]))).toEqual([
      "$email",
      "$name",
    ]);
    expect(getPropertyName(astNode("property_declaration", "", [property, secondProperty]))).toBe(
      "$email",
    );
    expect(getPropertyNames(astNode("property_declaration"))).toEqual([]);
    expect(getPropertyName(astNode("property_declaration"))).toBeNull();
    expect(
      getPropertyNames(astNode("property_declaration", "", [astNode("property_element")])),
    ).toEqual([]);
    expect(getInlineType(astNode("property", "", [named("union_type", "A|B")]))).toBe("A|B");
    expect(getInlineType(astNode("property"))).toBeUndefined();
  });

  it("builds complete, PHPDoc-backed, and empty property metadata", () => {
    const inline = astNode("property", "", [
      named("visibility_modifier", "private"),
      named("static_modifier", "static"),
      named("readonly_modifier", "readonly"),
      named("primitive_type", "string"),
      attributeList([attribute("Column")]),
    ]);
    expect(buildPropertyMeta(inline, "/** @var int */")).toEqual({
      visibility: "private",
      is_static: true,
      is_readonly: true,
      type: "string",
      type_source: "inline",
      attributes: [{ name: "Column" }],
    });
    expect(buildPropertyMeta(astNode("property"), "/** @var Legacy|null */")).toEqual({
      type: "Legacy|null",
      type_source: "phpdoc",
    });
    expect(buildPropertyMeta(astNode("property"), undefined)).toEqual({});
  });
});

describe("PHPDoc and synthetic symbol helpers", () => {
  it("finds PHPDoc through modifiers and rejects non-doc comments", () => {
    const doc = astNode("comment", "/** docs */");
    const modifier = astNode("visibility_modifier", "public", [], {}, doc);
    const attributes = astNode("attribute_list", "", [], {}, modifier);
    expect(getDocstring(astNode("class", "", [], {}, attributes), "/** docs */")).toBe(
      "/** docs */",
    );
    expect(getDocstring(astNode("class"), "")).toBeUndefined();
    expect(getDocstring(astNode("class", "", [], {}, named("name", "X")), "X"))
      .toBeUndefined();
    const plainComment = astNode("comment", "// docs");
    expect(getDocstring(astNode("class", "", [], {}, plainComment), "// docs"))
      .toBeUndefined();
  });

  it("synthesizes typed and untyped members and deduplicates real members", () => {
    const context = extractionContext();
    const parent = parentSymbol();
    context.symbols.push({ ...parent, id: "real", name: "getPosts", kind: "method", parent: parent.id });
    const declaration = astNode("class", "fixture");
    synthesizeDocstringTags(
      context,
      declaration,
      parent,
      "/** @property int $id @method getPosts() @method touch() */",
    );
    expect(context.symbols.map(({ name, kind, signature, meta }) => ({ name, kind, signature, meta })))
      .toEqual([
        { name: "getPosts", kind: "method", signature: undefined, meta: undefined },
        { name: "id", kind: "field", signature: "int", meta: { synthetic: true } },
        { name: "touch", kind: "method", signature: undefined, meta: { synthetic: true } },
      ]);
    synthesizeDocstringTags(context, declaration, parent, undefined);
    expect(context.symbols).toHaveLength(3);
  });

  it("handles absent and malformed promoted parameters", () => {
    const empty = extractionContext();
    emitPromotedConstructorFields(empty, astNode("method"), "class-id");
    expect(empty.symbols).toEqual([]);

    const missingVariable = astNode("property_promotion_parameter");
    const variableWithoutName = astNode("property_promotion_parameter", "", [
      astNode("variable_name"),
    ]);
    const ordinary = astNode("simple_parameter");
    const parameters = astNode("formal_parameters", "", [ordinary, missingVariable, variableWithoutName]);
    emitPromotedConstructorFields(
      empty,
      astNode("method", "", [parameters]),
      "class-id",
    );
    expect(empty.symbols).toEqual([]);

    const nameOnlyVariable = astNode("variable_name", "$raw", [named("name", "raw")]);
    const untypedPromotion = astNode("property_promotion_parameter", "fixture", [
      nameOnlyVariable,
    ]);
    emitPromotedConstructorFields(
      empty,
      astNode("method", "", [astNode("formal_parameters", "", [untypedPromotion])]),
      "class-id",
    );
    expect(empty.symbols[0]).toMatchObject({
      name: "$raw",
      meta: { from_constructor: true },
    });
  });

  it("emits fully described promoted fields using named-child parameter fallback", () => {
    const context = extractionContext();
    const variable = astNode("variable_name", "$id", [named("name", "id")]);
    const promoted = astNode("property_promotion_parameter", "fixture", [
      variable,
      named("visibility_modifier", "protected"),
      named("readonly_modifier", "readonly"),
      named("primitive_type", "int"),
      attributeList([attribute("Inject")]),
    ]);
    const parameters = astNode("formal_parameters", "", [promoted]);
    emitPromotedConstructorFields(context, astNode("method", "", [parameters]), "class-id");
    expect(context.symbols).toHaveLength(1);
    expect(context.symbols[0]).toMatchObject({
      name: "$id",
      kind: "field",
      parent: "class-id",
      meta: {
        from_constructor: true,
        visibility: "protected",
        is_readonly: true,
        type: "int",
        type_source: "inline",
        attributes: [{ name: "Inject" }],
      },
    });
  });
});

describe("PHP walker defensive shapes", () => {
  it("keeps incomplete nested namespace nodes without inventing children", () => {
    const nestedNamespace = astNode("namespace_definition", "fixture");
    const root = astNode("program", "fixture", [astNode("wrapper", "fixture", [nestedNamespace])]);
    const symbols = extractPhpSymbols(
      { rootNode: root } as unknown as TSTree,
      "test.php",
      "fixture",
      "test",
    );
    expect(symbols.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "<anonymous>", kind: "namespace" },
    ]);
  });

  it("handles anonymous declarations and incomplete child nodes without emitting junk", () => {
    const classBody = astNode("declaration_list", "", [
      astNode("use_declaration", "", [named("name", "Timestamped")]),
    ]);
    const anonymousClass = astNode(
      "class_declaration",
      "fixture",
      [named("readonly_modifier", "readonly"), attributeList([attribute("Entity")])],
      { body: classBody },
    );
    const anonymousInterface = astNode(
      "interface_declaration",
      "fixture",
      [attributeList([attribute("Contract")])],
      { body: astNode("declaration_list") },
    );
    const traitBody = astNode("declaration_list", "", [
      astNode("use_declaration", "", [named("qualified_name", "Vendor\\Reusable")]),
    ]);
    const anonymousTrait = astNode(
      "trait_declaration",
      "fixture",
      [attributeList([attribute("Reusable")])],
      { body: traitBody },
    );
    const enumBody = astNode("enum_declaration_list", "", [astNode("enum_case")]);
    const anonymousEnum = astNode("enum_declaration", "fixture", [
      attributeList([attribute("Serializable")]),
      enumBody,
    ]);
    const root = astNode("program", "fixture", [
      astNode("namespace_definition", "fixture"),
      anonymousClass,
      astNode("class_declaration", "fixture", [], { name: named("name", "NoBody") }),
      anonymousInterface,
      astNode("interface_declaration", "fixture", [], {
        name: named("name", "NoBodyInterface"),
      }),
      anonymousTrait,
      astNode("trait_declaration", "fixture", [], { name: named("name", "NoBodyTrait") }),
      anonymousEnum,
      astNode("enum_declaration", "fixture", [], { name: named("name", "NoBodyEnum") }),
      astNode("function_definition"),
      astNode("method_declaration"),
      astNode("method_declaration", "fixture", [], { name: named("name", "plain") }),
      astNode("property_declaration"),
      astNode("const_declaration", "", [named("comment", "ignored"), astNode("const_element")]),
      astNode("enum_case"),
    ]);
    const symbols = extractPhpSymbols({ rootNode: root } as unknown as TSTree, "test.php", "fixture", "test");

    expect(symbols.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "<anonymous>", kind: "namespace" },
      { name: "<anonymous>", kind: "class" },
      { name: "NoBody", kind: "class" },
      { name: "<anonymous>", kind: "interface" },
      { name: "NoBodyInterface", kind: "interface" },
      { name: "<anonymous>", kind: "type" },
      { name: "NoBodyTrait", kind: "type" },
      { name: "<anonymous>", kind: "enum" },
      { name: "NoBodyEnum", kind: "enum" },
      { name: "plain", kind: "method" },
    ]);
    expect(symbols[1]?.meta).toEqual({
      is_readonly: true,
      uses_traits: ["Timestamped"],
      attributes: [{ name: "Entity" }],
    });
    expect(symbols[3]?.meta).toEqual({ attributes: [{ name: "Contract" }] });
    expect(symbols[5]?.meta).toEqual({
      uses_traits: ["Vendor\\Reusable"],
      attributes: [{ name: "Reusable" }],
    });
    expect(symbols[7]?.meta).toEqual({ attributes: [{ name: "Serializable" }] });
  });
});
