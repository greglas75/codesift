import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Parser from "web-tree-sitter";
import { getParser, initParser } from "../../parser/parser-manager.js";
import {
  getActionProperty,
  handlerHasTopLevelReturn,
  methodName,
  receiverOfCall,
  stripActionQuotes,
  unwrapZodChain,
  walkAll,
} from "./ast.js";
import type { ActionsFileExtraction, ExtractedAction } from "./types.js";
import { extractZodObjectFields, isZObjectCall } from "./zod-ast.js";

const ACTIONS_FILE_CANDIDATES = [
  "src/actions/index.ts",
  "src/actions/index.js",
  "src/actions/index.mjs",
];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".jsx": "javascript",
};

function pickLanguage(filePath: string): string {
  for (const [extension, language] of Object.entries(LANGUAGE_BY_EXTENSION)) {
    if (filePath.endsWith(extension)) return language;
  }
  return "typescript";
}

function findActionsFile(root: string): { source: string; file: string } | null {
  for (const file of ACTIONS_FILE_CANDIDATES) {
    try {
      return { source: readFileSync(join(root, file), "utf-8"), file };
    } catch {
      // Preserve the audit's best-effort candidate lookup behavior.
    }
  }
  return null;
}

function createDescriptor(name: string, file: string, call: Parser.SyntaxNode): ExtractedAction {
  return {
    name,
    file,
    line: call.startPosition.row + 1,
    has_input_schema: false,
    input_fields: [],
    handler_missing_return: false,
    refine_on_top_level: false,
    has_passthrough: false,
    has_file_field: false,
  };
}

function populateInputDetails(descriptor: ExtractedAction, input: Parser.SyntaxNode): void {
  descriptor.has_input_schema = true;
  if (input.type === "call_expression") {
    const outerName = methodName(input);
    if (outerName === "refine" || outerName === "superRefine") {
      const receiver = receiverOfCall(input);
      if (receiver?.type === "call_expression" && isZObjectCall(receiver)) {
        descriptor.refine_on_top_level = true;
        descriptor.refine_line = input.startPosition.row + 1;
      }
    }
  }

  walkAll(input, (node) => {
    if (node.type !== "call_expression" || methodName(node) !== "passthrough") return;
    descriptor.has_passthrough = true;
    descriptor.passthrough_line = node.startPosition.row + 1;
  });

  const zodObject = unwrapZodChain(input);
  if (!zodObject) return;
  const { fields, hasFileField } = extractZodObjectFields(zodObject);
  descriptor.input_fields = fields;
  descriptor.has_file_field = hasFileField;
}

function extractAction(
  name: string,
  file: string,
  call: Parser.SyntaxNode,
): ExtractedAction {
  const descriptor = createDescriptor(name, file, call);
  const args = call.childForFieldName("arguments");
  const objectNode = args?.namedChildren.find((node) => node.type === "object");
  if (!objectNode) return descriptor;

  const acceptNode = getActionProperty(objectNode, "accept");
  if (acceptNode?.type === "string") {
    const accept = stripActionQuotes(acceptNode.text);
    if (accept === "json" || accept === "form") descriptor.accept = accept;
  }

  const inputNode = getActionProperty(objectNode, "input");
  if (inputNode) populateInputDetails(descriptor, inputNode);

  const handlerNode = getActionProperty(objectNode, "handler");
  if (handlerNode && (
    handlerNode.type === "arrow_function"
    || handlerNode.type === "function_expression"
    || handlerNode.type === "function"
  )) descriptor.handler_missing_return = !handlerHasTopLevelReturn(handlerNode);
  return descriptor;
}

function collectNestedAction(
  name: string,
  file: string,
  node: Parser.SyntaxNode,
  actions: ExtractedAction[],
): void {
  walkAll(node, (candidate) => {
    if (candidate.type !== "call_expression") return;
    if (candidate.childForFieldName("function")?.text !== "defineAction") return;
    actions.push(extractAction(name, file, candidate));
  });
}

function collectObjectPropertyAction(
  pair: Parser.SyntaxNode,
  file: string,
  actions: ExtractedAction[],
): void {
  if (pair.type !== "pair") return;
  const key = pair.childForFieldName("key");
  const value = pair.childForFieldName("value");
  if (!key || !value) return;
  const actionName = stripActionQuotes(key.text);
  if (value.type === "call_expression"
    && value.childForFieldName("function")?.text === "defineAction") {
    actions.push(extractAction(actionName, file, value));
    return;
  }
  collectNestedAction(actionName, file, value, actions);
}

function collectVariableActions(
  node: Parser.SyntaxNode,
  file: string,
  actions: ExtractedAction[],
): void {
  if (node.type !== "variable_declarator") return;
  const nameNode = node.childForFieldName("name");
  const valueNode = node.childForFieldName("value");
  if (!nameNode || !valueNode) return;

  if (valueNode.type === "call_expression"
    && valueNode.childForFieldName("function")?.text === "defineAction") {
    actions.push(extractAction(nameNode.text, file, valueNode));
    return;
  }
  if (valueNode.type !== "object") return;

  for (const pair of valueNode.namedChildren) collectObjectPropertyAction(pair, file, actions);
}

export async function parseActionsFile(root: string): Promise<ActionsFileExtraction | null> {
  const actionsFile = findActionsFile(root);
  if (!actionsFile) return null;

  await initParser();
  const parser = await getParser(pickLanguage(actionsFile.file));
  if (!parser) return { file: actionsFile.file, actions: [] };

  let tree: Parser.Tree;
  try {
    tree = parser.parse(actionsFile.source);
  } catch {
    return { file: actionsFile.file, actions: [] };
  }

  const actions: ExtractedAction[] = [];
  walkAll(tree.rootNode, (node) => collectVariableActions(node, actionsFile.file, actions));
  return { file: actionsFile.file, actions };
}
