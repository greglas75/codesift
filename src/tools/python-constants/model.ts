import type { Node as TSNode, Tree as TSTree } from "web-tree-sitter";
import type { CodeIndex, CodeSymbol } from "../../types.js";

export type PythonLiteralKind =
  | "string"
  | "integer"
  | "float"
  | "boolean"
  | "null"
  | "list"
  | "tuple"
  | "dict";

export interface PythonLiteralObject {
  [key: string]: PythonLiteralValue;
}

export type PythonLiteralValue =
  | string
  | number
  | boolean
  | null
  | PythonLiteralValue[]
  | PythonLiteralObject;

export interface ResolutionHop {
  name: string;
  file: string;
  line: number;
}

export interface ResolvedDefaultParameter {
  name: string;
  resolved: boolean;
  value_kind?: PythonLiteralKind;
  value?: PythonLiteralValue;
  value_text: string;
  confidence: "high" | "medium" | "low";
  alias_chain: ResolutionHop[];
  reason?: string;
}

export interface ConstantResolutionMatch {
  symbol_name: string;
  symbol_kind: CodeSymbol["kind"];
  file: string;
  line: number;
  resolved: boolean;
  /**
   * Source language of the matched symbol. Optional because the original
   * Python-only resolver did not populate it; multi-language consumers
   * (e.g. typescript-constants-tools) set it to disambiguate matches.
   */
  language?: string;
  value_kind?: PythonLiteralKind;
  value?: PythonLiteralValue;
  value_text?: string;
  default_parameters?: ResolvedDefaultParameter[];
  confidence: "high" | "medium" | "low";
  alias_chain: ResolutionHop[];
  reason?: string;
}

export interface ConstantResolutionResult {
  query: string;
  matches: ConstantResolutionMatch[];
}

interface AssignmentBinding {
  rhs: TSNode;
  line: number;
}

interface ImportBinding {
  imported_name: string;
  source_file: string;
  line: number;
}

interface PythonFileContext {
  source: string;
  tree: TSTree;
  assignments: Map<string, AssignmentBinding>;
  imports: Map<string, ImportBinding>;
}

interface EvaluationResult {
  resolved: boolean;
  value_kind?: PythonLiteralKind;
  value?: PythonLiteralValue;
  value_text: string;
  alias_chain: ResolutionHop[];
  used_import: boolean;
  reason?: string;
}

interface ResolutionState {
  index: CodeIndex;
  fileCache: Map<string, PythonFileContext | null>;
  visited: Set<string>;
  maxDepth: number;
}

export type {
  AssignmentBinding,
  EvaluationResult,
  ImportBinding,
  PythonFileContext,
  ResolutionState,
};
