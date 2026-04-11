import type Parser from "web-tree-sitter";
import type { CodeSymbol } from "../../types.js";
import { makeSymbol } from "./_shared.js";

/**
 * Dedicated extractor for `*.gradle.kts` files. Uses the Kotlin tree-sitter
 * parser but emits structured configuration symbols instead of treating DSL
 * calls as opaque function invocations.
 *
 * Emits three kinds of symbols, all as `variable` with meta tagging:
 *
 *   meta.gradle_type = "plugin"
 *     e.g. `kotlin("jvm") version "1.9.0"` → name="jvm", version="1.9.0"
 *   meta.gradle_type = "dependency"
 *     e.g. `implementation("io.ktor:ktor-server:2.3.0")` →
 *       name="io.ktor:ktor-server:2.3.0", configuration="implementation"
 *   meta.gradle_type = "config"
 *     e.g. `android { namespace = "com.example" }` →
 *       name="android.namespace", value="com.example"
 */

/** Top-level DSL blocks whose bodies contain structured config entries. */
const PLUGIN_BLOCKS = new Set(["plugins"]);
const DEPENDENCY_BLOCKS = new Set(["dependencies"]);
const CONFIG_BLOCKS = new Set([
  "android", "kotlin", "java", "buildscript", "allprojects", "subprojects",
  "application", "jvm", "tasks",
]);

/** Recognized plugin declarators inside a `plugins { }` block. */
const PLUGIN_DECLARATORS = new Set(["id", "kotlin", "alias"]);

export function extractGradleKtsSymbols(
  tree: Parser.Tree,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  // Walk only top-level call_expression children — Gradle DSL blocks are
  // always at the file root. Deeper walks would mistake unrelated function
  // calls for config blocks.
  for (const child of tree.rootNode.namedChildren) {
    if (child.type !== "call_expression") continue;
    const blockName = getBlockName(child);
    if (!blockName) continue;

    const lambda = getLambdaBody(child);
    if (!lambda) continue;

    if (PLUGIN_BLOCKS.has(blockName)) {
      emitPluginSymbols(lambda, filePath, source, repo, symbols);
    } else if (DEPENDENCY_BLOCKS.has(blockName)) {
      emitDependencySymbols(lambda, filePath, source, repo, symbols);
    } else if (CONFIG_BLOCKS.has(blockName)) {
      emitConfigSymbols(lambda, blockName, filePath, source, repo, symbols);
    }
  }

  return symbols;
}

// --- Helpers ---

/**
 * Returns the identifier name of a top-level DSL call like `plugins {` or
 * `android {`. Null if the call_expression doesn't match the block shape.
 */
function getBlockName(call: Parser.SyntaxNode): string | null {
  const ident = call.namedChildren.find((c) => c.type === "identifier");
  return ident?.text ?? null;
}

/**
 * Returns the inner `lambda_literal` of a DSL block call. Null if the call
 * doesn't end with a trailing lambda (e.g. `android()` without a body).
 */
function getLambdaBody(call: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const annotatedLambda = call.namedChildren.find(
    (c) => c.type === "annotated_lambda",
  );
  if (!annotatedLambda) return null;
  return annotatedLambda.namedChildren.find(
    (c) => c.type === "lambda_literal",
  ) ?? null;
}

/**
 * Extracts a plugin symbol from a `plugins { }` entry. Handles two forms:
 *
 *   kotlin("jvm") version "1.9.0"
 *   id("com.android.application")
 *
 * The first appears in the AST as `infix_expression > call_expression + identifier("version") + string_literal`.
 * The second appears as a bare `call_expression > identifier + value_arguments`.
 */
function emitPluginSymbols(
  lambda: Parser.SyntaxNode,
  filePath: string,
  source: string,
  repo: string,
  symbols: CodeSymbol[],
): void {
  for (const entry of lambda.namedChildren) {
    if (entry.type === "call_expression") {
      const plugin = parsePluginCall(entry);
      if (plugin) {
        symbols.push(makePluginSymbol(entry, plugin, filePath, source, repo));
      }
      continue;
    }
    if (entry.type === "infix_expression") {
      // kotlin("jvm") version "1.9.0"
      const call = entry.namedChildren.find((c) => c.type === "call_expression");
      if (!call) continue;
      const plugin = parsePluginCall(call);
      if (!plugin) continue;

      // Find trailing string_literal as version (right side of infix).
      const strLit = entry.namedChildren
        .filter((c) => c.type === "string_literal")
        .pop();
      if (strLit) plugin.version = unquoteStringLiteral(strLit);

      symbols.push(makePluginSymbol(entry, plugin, filePath, source, repo));
    }
  }
}

interface ParsedPlugin {
  declarator: string;
  name: string;
  version?: string;
}

function parsePluginCall(call: Parser.SyntaxNode): ParsedPlugin | null {
  const callee = call.namedChildren.find((c) => c.type === "identifier");
  if (!callee || !PLUGIN_DECLARATORS.has(callee.text)) return null;

  const args = call.namedChildren.find((c) => c.type === "value_arguments");
  if (!args) return null;
  const firstArg = args.namedChildren.find((c) => c.type === "value_argument");
  if (!firstArg) return null;
  const strLit = firstArg.namedChildren.find((c) => c.type === "string_literal");
  if (!strLit) return null;

  return {
    declarator: callee.text,
    name: unquoteStringLiteral(strLit),
  };
}

function makePluginSymbol(
  node: Parser.SyntaxNode,
  plugin: ParsedPlugin,
  filePath: string,
  source: string,
  repo: string,
): CodeSymbol {
  const meta: Record<string, unknown> = {
    gradle_type: "plugin",
    declarator: plugin.declarator,
  };
  if (plugin.version) meta["version"] = plugin.version;

  return makeSymbol(node, plugin.name, "variable", filePath, source, repo, {
    meta,
  });
}

/**
 * Extracts dependency symbols from a `dependencies { }` body. Matches:
 *
 *   implementation("io.ktor:ktor-server:2.3.0")
 *   testImplementation("org.jetbrains.kotlin:kotlin-test")
 *   api(project(":core"))      // skipped — not a GAV coordinate
 *   runtimeOnly(libs.okhttp)   // skipped — version catalog, no string literal
 */
function emitDependencySymbols(
  lambda: Parser.SyntaxNode,
  filePath: string,
  source: string,
  repo: string,
  symbols: CodeSymbol[],
): void {
  for (const entry of lambda.namedChildren) {
    if (entry.type !== "call_expression") continue;

    const callee = entry.namedChildren.find((c) => c.type === "identifier");
    if (!callee) continue;
    const configuration = callee.text;

    const args = entry.namedChildren.find((c) => c.type === "value_arguments");
    if (!args) continue;
    const firstArg = args.namedChildren.find((c) => c.type === "value_argument");
    if (!firstArg) continue;
    const strLit = firstArg.namedChildren.find((c) => c.type === "string_literal");
    if (!strLit) continue;

    const coordinate = unquoteStringLiteral(strLit);
    symbols.push(
      makeSymbol(entry, coordinate, "variable", filePath, source, repo, {
        meta: {
          gradle_type: "dependency",
          configuration,
        },
      }),
    );
  }
}

/**
 * Extracts assignment entries from config blocks like `android { namespace = "x" }`.
 * Each assignment becomes a symbol named `{block}.{property}` with the raw
 * right-hand-side text stored in meta.value.
 */
function emitConfigSymbols(
  lambda: Parser.SyntaxNode,
  blockName: string,
  filePath: string,
  source: string,
  repo: string,
  symbols: CodeSymbol[],
): void {
  for (const entry of lambda.namedChildren) {
    if (entry.type !== "assignment") continue;

    const lhs = entry.namedChildren[0];
    if (!lhs || lhs.type !== "identifier") continue;

    // The assignment's RHS is the last named child. Use its raw text so
    // strings keep their literal form and numbers stay as numbers.
    const rhs = entry.namedChildren[entry.namedChildren.length - 1];
    if (!rhs || rhs === lhs) continue;

    const value = rhs.type === "string_literal"
      ? unquoteStringLiteral(rhs)
      : rhs.text;

    symbols.push(
      makeSymbol(
        entry,
        `${blockName}.${lhs.text}`,
        "variable",
        filePath,
        source,
        repo,
        {
          meta: {
            gradle_type: "config",
            block: blockName,
            property: lhs.text,
            value,
          },
        },
      ),
    );
  }
}

function unquoteStringLiteral(node: Parser.SyntaxNode): string {
  const content = node.namedChildren.find((c) => c.type === "string_content");
  if (content) return content.text;
  return node.text.replace(/^"|"$/g, "");
}
