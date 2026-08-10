import type { Parser, Node as TSNode, Tree as TSTree } from "web-tree-sitter";
import type { CodeIndex } from "../../types.js";
import type {
  PythonLiteralKind,
  PythonLiteralValue,
  ResolutionHop,
} from "../python-constants-tools.js";

export interface AssignmentBinding {
  rhs: TSNode;
  line: number;
}

export interface ImportBinding {
  kind: "named" | "default" | "namespace";
  source_file: string;
  imported_name?: string;
  line: number;
}

export interface DefaultExportBinding {
  name?: string;
  node?: TSNode;
  line: number;
}

export interface TypeScriptFileContext {
  source: string;
  tree: TSTree;
  assignments: Map<string, AssignmentBinding>;
  imports: Map<string, ImportBinding>;
  default_export?: DefaultExportBinding;
}

export interface EvaluationResult {
  resolved: boolean;
  value_kind?: PythonLiteralKind;
  value?: PythonLiteralValue;
  value_text: string;
  alias_chain: ResolutionHop[];
  used_import: boolean;
  reason?: string;
}

export interface ResolutionState {
  index: CodeIndex;
  parser: Parser;
  fileCache: Map<string, TypeScriptFileContext | null>;
  retiredTrees: TSTree[];
  normalizedPathMap: Map<string, string>;
  visited: Set<string>;
  maxDepth: number;
}
