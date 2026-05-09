import type Parser from "web-tree-sitter";
import type { CodeSymbol, SymbolKind } from "../../types.js";
import { getNodeName, makeSymbol } from "./_shared.js";

// --- PHPDoc tag parser ---

/**
 * Parse `@property` and `@method` tags from a PHPDoc block.
 * Used to synthesize Yii2 ActiveRecord magic properties (which live only in
 * the docblock, not as real PHP fields).
 *
 * Supports forms:
 *   @property int $id                  → { tag: "property", name: "id", type: "int" }
 *   @property string $name             → { tag: "property", name: "name", type: "string" }
 *   @method getPosts()                 → { tag: "method", name: "getPosts" }
 *   @method ActiveQuery getPosts()     → { tag: "method", name: "getPosts", type: "ActiveQuery" }
 *
 * Returns [] for empty / undefined input. Tag order is preserved.
 */
export function parsePhpDocTags(
  docstring?: string,
): Array<{ tag: "property" | "method"; name: string; type?: string }> {
  if (!docstring) return [];
  const results: Array<{ tag: "property" | "method"; name: string; type?: string }> = [];

  const propRe = /@property(?:-read|-write)?\s+(\S+)\s+\$(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = propRe.exec(docstring)) !== null) {
    const entry: { tag: "property"; name: string; type?: string } = {
      tag: "property",
      name: m[2]!,
    };
    if (m[1]) entry.type = m[1];
    results.push(entry);
  }

  // @method [returnType] name(args)
  // - With return type:  @method ActiveQuery getPosts(int $limit)
  // - Without type:      @method getPosts()
  const methodRe = /@method\s+(?:(\S+)\s+)?(\w+)\s*\(/g;
  while ((m = methodRe.exec(docstring)) !== null) {
    const entry: { tag: "method"; name: string; type?: string } = {
      tag: "method",
      name: m[2]!,
    };
    if (m[1]) entry.type = m[1];
    results.push(entry);
  }

  return results;
}

/**
 * Extract a `@var T` type annotation from a PHPDoc block. Used for inferring
 * property types in pre-PHP-7.4 codebases that keep typing in docblocks
 * rather than as inline type hints. Returns the raw type string (no further
 * normalization) or undefined if no `@var` is present.
 *
 * Examples:
 *   /** @var string *\/        → "string"
 *   /** @var User|null *\/     → "User|null"
 *   /** @var int[] *\/         → "int[]"
 */
export function parsePhpDocVar(docstring?: string): string | undefined {
  if (!docstring) return undefined;
  const m = /@var\s+(\S+)/.exec(docstring);
  return m?.[1];
}

// --- Helpers ---

/**
 * PHP docblocks are `comment` nodes starting with `/**` that precede a declaration.
 * Walk backwards through siblings collecting contiguous doc comments.
 */
function getDocstring(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  let prev = node.previousNamedSibling;

  // Skip visibility_modifier and other attributes to reach the comment
  while (prev && (prev.type === "visibility_modifier" || prev.type === "attribute_list")) {
    prev = prev.previousNamedSibling;
  }

  if (!prev || prev.type !== "comment") return undefined;

  const text = source.slice(prev.startIndex, prev.endIndex);
  if (!text.startsWith("/**")) return undefined;

  return text;
}

/**
 * Extract parameter list and optional return type.
 * e.g. "(string $name, int $age = 0): bool"
 */
function getSignature(
  node: Parser.SyntaxNode,
  source: string,
): string | undefined {
  const params = node.childForFieldName("parameters");
  if (!params) return undefined;

  let sig = source.slice(params.startIndex, params.endIndex);

  const returnType = node.childForFieldName("return_type");
  if (returnType) {
    sig += ": " + source.slice(returnType.startIndex, returnType.endIndex);
  }

  return sig;
}

/**
 * Test base classes that mark a class as a test suite. Includes PHPUnit
 * (TestCase) and Codeception (Unit, Cest, Cept) — the latter pair are the
 * canonical Codeception base classes used in panels like tgm-panel.
 */
const TEST_BASE_NAMES = new Set([
  "TestCase",
  "Unit",
  "Cest",
  "Cept",
]);

/**
 * Extract the list of base class names from a `base_clause` node. Returns
 * fully-qualified names exactly as written in source (e.g. ["BaseUser",
 * "\\yii\\db\\ActiveRecord", "Codeception\\Test\\Unit"]). Aliases stay as
 * source-side names — namespace resolution is the resolver's job, not the
 * extractor's.
 */
function parseBaseClause(baseClause: Parser.SyntaxNode | null): string[] {
  if (!baseClause) return [];
  const names: string[] = [];
  for (const child of baseClause.namedChildren) {
    if (child.type === "name" || child.type === "qualified_name") {
      const text = child.text.trim();
      if (text) names.push(text);
    }
  }
  // Fallback: tree-sitter-php sometimes flattens children. Strip the keyword
  // prefix and split on commas if no structured children were found.
  if (names.length === 0) {
    const stripped = baseClause.text.replace(/^extends\s+/, "").trim();
    if (stripped) {
      for (const n of stripped.split(/\s*,\s*/)) {
        if (n) names.push(n);
      }
    }
  }
  return names;
}

/**
 * Extract the list of interface names from a `class_interface_clause` node.
 * Mirrors `parseBaseClause` but strips the `implements` keyword.
 */
function parseInterfaceClause(clause: Parser.SyntaxNode | null): string[] {
  if (!clause) return [];
  const names: string[] = [];
  for (const child of clause.namedChildren) {
    if (child.type === "name" || child.type === "qualified_name") {
      const text = child.text.trim();
      if (text) names.push(text);
    }
  }
  if (names.length === 0) {
    const stripped = clause.text.replace(/^implements\s+/, "").trim();
    if (stripped) {
      for (const n of stripped.split(/\s*,\s*/)) {
        if (n) names.push(n);
      }
    }
  }
  return names;
}

/**
 * Walk a class/trait body and collect the names of traits used via
 * `use TraitName;` declarations. Returns FQ names as written.
 */
function collectTraitUses(body: Parser.SyntaxNode | null): string[] {
  if (!body) return [];
  const traits: string[] = [];
  for (const child of body.namedChildren) {
    if (child.type !== "use_declaration") continue;
    for (const grand of child.namedChildren) {
      if (grand.type === "name" || grand.type === "qualified_name") {
        const t = grand.text.trim();
        if (t) traits.push(t);
      }
    }
  }
  return traits;
}

/**
 * Look at a class/method/property declaration's children for modifier nodes.
 * tree-sitter-php emits these as siblings of the name, with types like
 * `abstract_modifier`, `final_modifier`, `readonly_modifier`, `static_modifier`,
 * and `visibility_modifier`. Returns a set of plain string flags.
 */
function collectModifiers(node: Parser.SyntaxNode): {
  visibility?: "public" | "private" | "protected";
  is_static?: boolean;
  is_abstract?: boolean;
  is_final?: boolean;
  is_readonly?: boolean;
} {
  const out: ReturnType<typeof collectModifiers> = {};
  for (const child of node.namedChildren) {
    const t = child.type;
    if (t === "visibility_modifier") {
      const txt = child.text.trim();
      if (txt === "public" || txt === "private" || txt === "protected") {
        out.visibility = txt;
      }
    } else if (t === "static_modifier" || (t === "modifier" && child.text === "static")) {
      out.is_static = true;
    } else if (t === "abstract_modifier" || (t === "modifier" && child.text === "abstract")) {
      out.is_abstract = true;
    } else if (t === "final_modifier" || (t === "modifier" && child.text === "final")) {
      out.is_final = true;
    } else if (t === "readonly_modifier" || (t === "modifier" && child.text === "readonly")) {
      out.is_readonly = true;
    }
  }
  return out;
}

/**
 * Extract PHP 8.0+ attribute list from a declaration. Attributes appear as
 * an `attribute_list` named child preceding the declaration; each contains
 * one or more `attribute_group` → `attribute` nodes.
 *
 * Returns shape suitable for storing in `meta.attributes`:
 *   #[Route('/api', methods: ['GET'])] → { name: "Route", args: "'/api', methods: ['GET']" }
 */
function parseAttributes(
  node: Parser.SyntaxNode,
): Array<{ name: string; args?: string }> {
  const attrs: Array<{ name: string; args?: string }> = [];
  // Attributes precede the decl as a sibling; we walk the immediate previous
  // siblings until we hit something that is not an attribute_list.
  let prev = node.previousNamedSibling;
  while (prev && prev.type === "attribute_list") {
    walkAttributeList(prev, attrs);
    prev = prev.previousNamedSibling;
  }
  // tree-sitter-php sometimes nests attribute_list as a named child of the
  // declaration itself. Collect those too.
  for (const child of node.namedChildren) {
    if (child.type === "attribute_list") {
      walkAttributeList(child, attrs);
    }
  }
  return attrs;
}

function walkAttributeList(
  list: Parser.SyntaxNode,
  out: Array<{ name: string; args?: string }>,
): void {
  for (const group of list.namedChildren) {
    if (group.type !== "attribute_group" && group.type !== "attribute") continue;
    const attrNodes =
      group.type === "attribute_group"
        ? group.namedChildren.filter((c) => c.type === "attribute")
        : [group];
    for (const attr of attrNodes) {
      // attribute → name + optional arguments
      const nameNode = attr.namedChildren.find(
        (c) => c.type === "name" || c.type === "qualified_name",
      );
      if (!nameNode) continue;
      const argsNode = attr.namedChildren.find((c) => c.type === "arguments");
      const entry: { name: string; args?: string } = { name: nameNode.text };
      if (argsNode) {
        // Strip outer parens, trim — keep raw arg list as a string for cheap
        // pattern matching downstream (no need to AST-walk every literal).
        entry.args = argsNode.text.replace(/^\(/, "").replace(/\)$/, "").trim();
      }
      out.push(entry);
    }
  }
}

/**
 * Check if a class extends a known test-runner base class. Covers both
 * PHPUnit (`TestCase`) and Codeception (`Unit`, `Cest`, `Cept`). Match is
 * substring-based on the last name segment so namespace prefixes don't
 * matter (e.g. `Codeception\\Test\\Unit` ends with `Unit`).
 */
function isTestCaseClass(node: Parser.SyntaxNode): boolean {
  const bases = collectClassExtends(node);
  for (const b of bases) {
    const last = b.split(/[\\\\]+/).pop() ?? "";
    if (TEST_BASE_NAMES.has(last)) return true;
  }
  return false;
}

/**
 * Helper: read the `extends` list from a class_declaration node, regardless
 * of whether the parser exposes it via `childForFieldName("base_clause")`
 * or as a named child of type `base_clause`.
 */
function collectClassExtends(node: Parser.SyntaxNode): string[] {
  let baseClause = node.childForFieldName("base_clause");
  if (!baseClause) {
    baseClause = node.namedChildren.find((c) => c.type === "base_clause") ?? null;
  }
  return parseBaseClause(baseClause);
}

/**
 * Helper: read the `implements` list from a class_declaration node.
 */
function collectClassImplements(node: Parser.SyntaxNode): string[] {
  let clause = node.childForFieldName("class_interface_clause");
  if (!clause) {
    clause =
      node.namedChildren.find((c) => c.type === "class_interface_clause") ??
      null;
  }
  return parseInterfaceClause(clause);
}

/**
 * Classify a method declaration based on PHPUnit patterns.
 */
function classifyMethod(
  name: string,
  parentIsTest: boolean,
  docstring: string | undefined,
): SymbolKind {
  // Test hooks
  const hooks = ["setUp", "tearDown", "setUpBeforeClass", "tearDownAfterClass"];
  if (hooks.includes(name)) return "test_hook";

  // Test case: method starts with "test" or has @test annotation
  if (parentIsTest) {
    if (name.startsWith("test")) return "test_case";
    if (docstring?.includes("@test")) return "test_case";
  }

  return "method";
}

/**
 * Extract name from a property_element node.
 * Property elements contain variable_name → name nodes.
 * Returns the name without the $ prefix.
 */
function getPropertyName(node: Parser.SyntaxNode): string | null {
  for (const child of node.namedChildren) {
    if (child.type === "property_element") {
      // variable_name → name
      const varName = child.namedChildren.find(c => c.type === "variable_name");
      if (varName) {
        const nameNode = varName.namedChildren.find(c => c.type === "name");
        return nameNode ? "$" + nameNode.text : null;
      }
    }
  }
  return null;
}

/**
 * Pull a type annotation off a property_declaration / parameter / promoted
 * parameter node. Walks named children looking for the first type-bearing
 * node. Returns the raw source text exactly as written.
 *
 * Type-bearing node types in tree-sitter-php:
 *   primitive_type        (string, int, bool, float, array, mixed, void, ...)
 *   named_type            (User, \\App\\Model)
 *   optional_type         (?T) — wraps the inner type
 *   union_type            (PHP 8.0+: A|B)
 *   intersection_type     (PHP 8.1+: A&B)
 *   disjunctive_normal_form_type (PHP 8.2+: (A&B)|C)
 */
function getInlineType(node: Parser.SyntaxNode): string | undefined {
  const TYPE_NODES = new Set([
    "primitive_type",
    "named_type",
    "optional_type",
    "union_type",
    "intersection_type",
    "disjunctive_normal_form_type",
  ]);
  for (const child of node.namedChildren) {
    if (TYPE_NODES.has(child.type)) {
      return child.text.trim();
    }
  }
  return undefined;
}

/**
 * Build a Property metadata object from a property_declaration node.
 * Combines inline type (PHP 7.4+ typed property) with `@var T` from a
 * leading PHPDoc block. Inline type takes precedence; `@var` is used when
 * inline type is absent (legacy 7.2/7.3 code).
 */
function buildPropertyMeta(
  node: Parser.SyntaxNode,
  docstring: string | undefined,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const modifiers = collectModifiers(node);
  if (modifiers.visibility) meta.visibility = modifiers.visibility;
  if (modifiers.is_static) meta.is_static = true;
  if (modifiers.is_readonly) meta.is_readonly = true;

  const inlineType = getInlineType(node);
  const docVar = parsePhpDocVar(docstring);
  if (inlineType) {
    meta.type = inlineType;
    meta.type_source = "inline";
  } else if (docVar) {
    meta.type = docVar;
    meta.type_source = "phpdoc";
  }

  const attrs = parseAttributes(node);
  if (attrs.length > 0) meta.attributes = attrs;
  return meta;
}

// --- Main extractor ---

export function extractPhpSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  // Synthesize @property / @method tags from a declaration's docblock into
  // real CodeSymbols with meta.synthetic=true. Used by class/interface/trait
  // cases — any PHP declaration that can carry a PHPDoc block.
  // Dedup rule: if a real (non-synthetic) member with the same name+kind
  // already exists under the same parent, skip synthesis. Body walk must run
  // BEFORE this function so the real members are in the symbols array.
  function synthesizeDocstringTags(
    node: Parser.SyntaxNode,
    parent: CodeSymbol,
    docstring: string | undefined,
  ): void {
    if (!docstring) return;
    const tags = parsePhpDocTags(docstring);
    for (const tag of tags) {
      const targetKind: SymbolKind = tag.tag === "property" ? "field" : "method";
      const realExists = symbols.some(
        (s) =>
          s.parent === parent.id &&
          s.name === tag.name &&
          s.kind === targetKind &&
          !s.meta?.synthetic,
      );
      if (realExists) continue;
      const synOpts: {
        parentId: string;
        signature?: string;
        meta: Record<string, unknown>;
      } = {
        parentId: parent.id,
        meta: { synthetic: true },
      };
      if (tag.type) synOpts.signature = tag.type;
      const synthetic = makeSymbol(
        node,
        tag.name,
        targetKind,
        filePath,
        source,
        repo,
        synOpts,
      );
      symbols.push(synthetic);
    }
  }

  /**
   * Emit synthetic `field` symbols for PHP 8.0+ promoted constructor params.
   *
   * Promoted ctor params (`public readonly string $name` inside a __construct
   * signature) are real properties at runtime, but the property has no
   * separate `property_declaration` in the class body — only the parameter
   * inside `formal_parameters`. Without this, downstream tools see a class
   * with N parameters in its ctor and think the class has 0 properties.
   *
   * Each emitted symbol carries `meta.from_constructor: true` so callers
   * (e.g. analyzeActiveRecord, find_php_god_model) can distinguish promoted
   * fields from declared ones if they need to.
   */
  function emitPromotedCtorFields(
    methodNode: Parser.SyntaxNode,
    classId: string,
  ): void {
    const params = methodNode.childForFieldName("parameters")
      ?? methodNode.namedChildren.find((c) => c.type === "formal_parameters");
    if (!params) return;
    for (const child of params.namedChildren) {
      if (child.type !== "property_promotion_parameter") continue;
      const varName = child.namedChildren.find((c) => c.type === "variable_name");
      if (!varName) continue;
      const nameNode = varName.namedChildren.find((c) => c.type === "name");
      if (!nameNode) continue;
      const propName = "$" + nameNode.text;

      const modifiers = collectModifiers(child);
      const inlineType = getInlineType(child);
      const attrs = parseAttributes(child);

      const meta: Record<string, unknown> = { from_constructor: true };
      if (modifiers.visibility) meta.visibility = modifiers.visibility;
      if (modifiers.is_readonly) meta.is_readonly = true;
      if (inlineType) {
        meta.type = inlineType;
        meta.type_source = "inline";
      }
      if (attrs.length > 0) meta.attributes = attrs;

      symbols.push(
        makeSymbol(child, propName, "field", filePath, source, repo, {
          parentId: classId,
          meta,
        }),
      );
    }
  }

  function walk(node: Parser.SyntaxNode, parentId?: string, parentIsTest = false): void {
    switch (node.type) {
      case "namespace_definition": {
        const nameNode = node.childForFieldName("name");
        const name = nameNode?.text ?? "<anonymous>";
        const sym = makeSymbol(node, name, "namespace", filePath, source, repo, {
          parentId,
        });
        symbols.push(sym);

        // Walk body with namespace as parent
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            walk(child, sym.id, false);
          }
        } else {
          // Namespace without braces — remaining siblings are children
          // (tree-sitter handles this by putting declarations as siblings)
          // We continue walking at the parent level, but with namespace as parent
          // This is handled naturally since siblings follow after this node
        }
        return;
      }

      case "class_declaration": {
        const name = getNodeName(node) ?? "<anonymous>";
        const isTest = isTestCaseClass(node);
        const kind: SymbolKind = isTest ? "test_suite" : "class";
        const docstring = getDocstring(node, source);
        const extendsList = collectClassExtends(node);
        const implementsList = collectClassImplements(node);
        const body = node.childForFieldName("body");
        const traitUses = collectTraitUses(body);
        const modifiers = collectModifiers(node);
        const attributes = parseAttributes(node);

        const meta: Record<string, unknown> = {};
        if (modifiers.is_abstract) meta.is_abstract = true;
        if (modifiers.is_final) meta.is_final = true;
        if (modifiers.is_readonly) meta.is_readonly = true;
        if (traitUses.length > 0) meta.uses_traits = traitUses;
        if (attributes.length > 0) meta.attributes = attributes;

        const opts: Parameters<typeof makeSymbol>[6] = {
          parentId,
          docstring,
        };
        if (extendsList.length > 0) opts.extends = extendsList;
        if (implementsList.length > 0) opts.implements = implementsList;
        if (Object.keys(meta).length > 0) opts.meta = meta;

        const sym = makeSymbol(node, name, kind, filePath, source, repo, opts);
        symbols.push(sym);

        // Walk class body FIRST so real methods/fields are in `symbols`
        // before dedup runs for synthetic @property/@method tags.
        if (body) {
          for (const child of body.namedChildren) {
            walk(child, sym.id, isTest);
          }
        }

        synthesizeDocstringTags(node, sym, docstring);
        return;
      }

      case "interface_declaration": {
        const name = getNodeName(node) ?? "<anonymous>";
        const docstring = getDocstring(node, source);
        const extendsList = collectClassExtends(node);
        const attributes = parseAttributes(node);

        const meta: Record<string, unknown> = {};
        if (attributes.length > 0) meta.attributes = attributes;

        const opts: Parameters<typeof makeSymbol>[6] = {
          parentId,
          docstring,
        };
        if (extendsList.length > 0) opts.extends = extendsList;
        if (Object.keys(meta).length > 0) opts.meta = meta;

        const sym = makeSymbol(
          node,
          name,
          "interface",
          filePath,
          source,
          repo,
          opts,
        );
        symbols.push(sym);

        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            walk(child, sym.id, false);
          }
        }

        synthesizeDocstringTags(node, sym, docstring);
        return;
      }

      case "trait_declaration": {
        const name = getNodeName(node) ?? "<anonymous>";
        const docstring = getDocstring(node, source);
        const body = node.childForFieldName("body");
        const traitUses = collectTraitUses(body);
        const attributes = parseAttributes(node);

        const meta: Record<string, unknown> = {};
        if (traitUses.length > 0) meta.uses_traits = traitUses;
        if (attributes.length > 0) meta.attributes = attributes;

        const opts: Parameters<typeof makeSymbol>[6] = {
          parentId,
          docstring,
        };
        if (Object.keys(meta).length > 0) opts.meta = meta;

        const sym = makeSymbol(
          node,
          name,
          "type",
          filePath,
          source,
          repo,
          opts,
        );
        symbols.push(sym);

        if (body) {
          for (const child of body.namedChildren) {
            walk(child, sym.id, false);
          }
        }

        synthesizeDocstringTags(node, sym, docstring);
        return;
      }

      case "enum_declaration": {
        const name = getNodeName(node) ?? "<anonymous>";

        // PHP 8.1 backed enum: `enum Status: string {…}`. The backing type
        // appears as a `primitive_type` direct child of enum_declaration,
        // sitting between the name and the body. Capture it so downstream
        // tools (e.g. M1 enum-from-class-consts migration assist) can tell
        // backed from pure enums.
        let backedType: string | undefined;
        for (const child of node.namedChildren) {
          if (child.type === "primitive_type") {
            backedType = child.text.trim();
            break;
          }
        }

        // PHP 8.1 enums can implement interfaces too.
        const implementsList = collectClassImplements(node);
        const attributes = parseAttributes(node);

        const meta: Record<string, unknown> = {};
        if (backedType) meta.backed_type = backedType;
        if (attributes.length > 0) meta.attributes = attributes;

        const opts: Parameters<typeof makeSymbol>[6] = {
          parentId,
          docstring: getDocstring(node, source),
        };
        if (implementsList.length > 0) opts.implements = implementsList;
        if (Object.keys(meta).length > 0) opts.meta = meta;

        const sym = makeSymbol(node, name, "enum", filePath, source, repo, opts);
        symbols.push(sym);

        // tree-sitter-php uses `enum_declaration_list` for the body container,
        // not `body`. Try field name first for forward-compat, fall back to
        // the named child lookup.
        const body =
          node.childForFieldName("body") ??
          node.namedChildren.find((c) => c.type === "enum_declaration_list") ??
          null;
        if (body) {
          for (const child of body.namedChildren) {
            walk(child, sym.id, false);
          }
        }
        return;
      }

      case "function_definition": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "function", filePath, source, repo, {
            parentId,
            docstring: getDocstring(node, source),
            signature: getSignature(node, source),
          });
          symbols.push(sym);
        }
        return;
      }

      case "method_declaration": {
        const name = getNodeName(node);
        if (name) {
          const docstring = getDocstring(node, source);
          const kind = classifyMethod(name, parentIsTest, docstring);
          const modifiers = collectModifiers(node);
          const attributes = parseAttributes(node);

          const meta: Record<string, unknown> = {};
          if (modifiers.visibility) meta.visibility = modifiers.visibility;
          if (modifiers.is_static) meta.is_static = true;
          if (modifiers.is_abstract) meta.is_abstract = true;
          if (modifiers.is_final) meta.is_final = true;
          if (attributes.length > 0) meta.attributes = attributes;

          const opts: Parameters<typeof makeSymbol>[6] = {
            parentId,
            docstring,
            signature: getSignature(node, source),
          };
          if (Object.keys(meta).length > 0) opts.meta = meta;

          const sym = makeSymbol(node, name, kind, filePath, source, repo, opts);
          symbols.push(sym);

          // Promoted constructor params (PHP 8.0+): the body has no field
          // declarations for these, so synthesize them as `field` symbols
          // attached to the parent class. Only fires for __construct.
          if (name === "__construct" && parentId) {
            emitPromotedCtorFields(node, parentId);
          }
        }
        return;
      }

      case "property_declaration": {
        const propName = getPropertyName(node);
        if (propName) {
          const docstring = getDocstring(node, source);
          const meta = buildPropertyMeta(node, docstring);
          const opts: Parameters<typeof makeSymbol>[6] = {
            parentId,
            docstring,
          };
          if (Object.keys(meta).length > 0) opts.meta = meta;
          const sym = makeSymbol(node, propName, "field", filePath, source, repo, opts);
          symbols.push(sym);
        }
        return;
      }

      case "const_declaration": {
        // Class constants or global constants: const FOO = 'bar';
        // May have multiple const_element children
        for (const child of node.namedChildren) {
          if (child.type === "const_element") {
            // const_element doesn't use named fields — name is first child of type "name"
            const nameNode = child.namedChildren.find(c => c.type === "name");
            const name = nameNode?.text;
            if (name) {
              const sym = makeSymbol(child, name, "constant", filePath, source, repo, {
                parentId,
                docstring: getDocstring(node, source),
              });
              symbols.push(sym);
            }
          }
        }
        return;
      }

      case "enum_case": {
        const name = getNodeName(node);
        if (name) {
          const sym = makeSymbol(node, name, "constant", filePath, source, repo, {
            parentId,
          });
          symbols.push(sym);
        }
        return;
      }

      default:
        break;
    }

    // Default: walk children
    for (const child of node.namedChildren) {
      walk(child, parentId, parentIsTest);
    }
  }

  walk(tree.rootNode);
  return symbols;
}
