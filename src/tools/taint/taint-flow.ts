import type { Node as TSNode } from "web-tree-sitter";
import type { CodeSymbol } from "../../types.js";
import {
  appendHop,
  cloneEnv,
  dedupePaths,
  isAllowedPattern,
  lineForNode,
  mergeEnvs,
} from "./taint-model.js";
import type {
  AnalysisState,
  BlockResult,
  TaintEnv,
  TaintPath,
} from "./taint-model.js";
import {
  hasPotentialSink,
  hasPotentialSource,
  loadCallableContext,
} from "./python-context.js";
import { addTrace, evaluateExpression, isSessionTarget } from "./taint-expression.js";

async function analyzeAssignment(
  assignmentNode: TSNode,
  symbol: CodeSymbol,
  env: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
): Promise<TaintEnv> {
  const lhs = assignmentNode.childForFieldName("left") ?? assignmentNode.namedChild(0);
  const rhs = assignmentNode.childForFieldName("right") ?? assignmentNode.namedChild(1);
  const nextEnv = cloneEnv(env);
  if (!lhs || !rhs) return nextEnv;

  const rhsPaths = await evaluateExpression(rhs, symbol, env, state, context, analyzeCallableSymbol);
  if (rhsPaths.length === 0) return nextEnv;

  if (lhs.type === "identifier") {
    nextEnv.set(lhs.text, appendHop(rhsPaths, {
      kind: "assignment",
      file: symbol.file,
      line: lineForNode(symbol, assignmentNode),
      symbol_name: symbol.name,
      detail: `${lhs.text} = ${rhs.text}`,
    }));
    return nextEnv;
  }

  if (isSessionTarget(lhs) && isAllowedPattern(state.defaultSinks, "session-write", lhs.text)) {
    addTrace(state, context.entrySymbol, symbol, "session-write", assignmentNode, rhsPaths);
  }

  return nextEnv;
}

async function analyzeConditionalLike(
  node: TSNode,
  symbol: CodeSymbol,
  env: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
): Promise<BlockResult> {
  const conditionNodes = node.namedChildren.filter((child) => child.type !== "block" && child.type !== "else_clause" && child.type !== "elif_clause");
  for (const condition of conditionNodes) {
    await evaluateExpression(condition, symbol, env, state, context, analyzeCallableSymbol);
  }

  const branchResults: BlockResult[] = [];
  let hasElseLike = false;
  for (const child of node.namedChildren) {
    if (child.type === "block") {
      branchResults.push(await analyzeBlock(child, symbol, cloneEnv(env), state, context));
      continue;
    }
    if (child.type === "elif_clause") {
      hasElseLike = true;
      branchResults.push(await analyzeConditionalLike(child, symbol, cloneEnv(env), state, context));
      continue;
    }
    if (child.type === "else_clause") {
      hasElseLike = true;
      const elseBlock = child.namedChildren.find((grandchild) => grandchild.type === "block");
      if (elseBlock) branchResults.push(await analyzeBlock(elseBlock, symbol, cloneEnv(env), state, context));
    }
  }

  const baseEnvs = hasElseLike ? [] : [env];
  return {
    env: mergeEnvs(...baseEnvs, ...branchResults.map((entry) => entry.env)),
    return_paths: dedupePaths(branchResults.flatMap((entry) => entry.return_paths)),
  };
}

async function analyzeLoopLike(
  node: TSNode,
  symbol: CodeSymbol,
  env: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
): Promise<BlockResult> {
  for (const child of node.namedChildren) {
    if (child.type === "block") continue;
    await evaluateExpression(child, symbol, env, state, context, analyzeCallableSymbol);
  }

  const blockResults: BlockResult[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "block") continue;
    blockResults.push(await analyzeBlock(child, symbol, cloneEnv(env), state, context));
  }

  return {
    env: mergeEnvs(env, ...blockResults.map((entry) => entry.env)),
    return_paths: dedupePaths(blockResults.flatMap((entry) => entry.return_paths)),
  };
}

async function analyzeStatement(
  node: TSNode,
  symbol: CodeSymbol,
  env: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
): Promise<BlockResult> {
  switch (node.type) {
    case "expression_statement": {
      const inner = node.namedChildren[0];
      if (!inner) return { env, return_paths: [] };
      if (inner.type === "assignment") {
        return {
          env: await analyzeAssignment(inner, symbol, env, state, context),
          return_paths: [],
        };
      }
      await evaluateExpression(inner, symbol, env, state, context, analyzeCallableSymbol);
      return { env, return_paths: [] };
    }
    case "return_statement": {
      const valueNode = node.namedChildren[0];
      if (!valueNode) return { env, return_paths: [] };
      const valuePaths = await evaluateExpression(valueNode, symbol, env, state, context, analyzeCallableSymbol);
      if (valuePaths.length === 0) return { env, return_paths: [] };
      return {
        env,
        return_paths: appendHop(valuePaths, {
          kind: "return",
          file: symbol.file,
          line: lineForNode(symbol, node),
          symbol_name: symbol.name,
          detail: `return ${valueNode.text}`,
        }),
      };
    }
    case "if_statement":
    case "elif_clause":
      return await analyzeConditionalLike(node, symbol, env, state, context);
    case "for_statement":
    case "while_statement":
    case "with_statement":
    case "try_statement":
      return await analyzeLoopLike(node, symbol, env, state, context);
    case "pass_statement":
    case "break_statement":
    case "continue_statement":
      return { env, return_paths: [] };
    case "function_definition":
    case "async_function_definition":
    case "class_definition":
    case "decorated_definition":
      return { env, return_paths: [] };
    default: {
      for (const child of node.namedChildren) {
        if (child.type === "block") {
          await analyzeBlock(child, symbol, cloneEnv(env), state, context);
        } else {
          await evaluateExpression(child, symbol, env, state, context, analyzeCallableSymbol);
        }
      }
      return { env, return_paths: [] };
    }
  }
}

async function analyzeBlock(
  blockNode: TSNode,
  symbol: CodeSymbol,
  env: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
): Promise<BlockResult> {
  let currentEnv = cloneEnv(env);
  let returnPaths: TaintPath[] = [];

  for (const child of blockNode.namedChildren) {
    if (state.truncated) break;
    const result = await analyzeStatement(child, symbol, currentEnv, state, context);
    currentEnv = result.env;
    if (result.return_paths.length > 0) {
      returnPaths = dedupePaths([...returnPaths, ...result.return_paths]);
    }
  }

  return {
    env: currentEnv,
    return_paths: returnPaths,
  };
}

async function analyzeCallableSymbol(
  symbol: CodeSymbol,
  initialEnv: TaintEnv,
  state: AnalysisState,
  context: { entrySymbol: CodeSymbol; depth: number; callStack: string[] },
): Promise<BlockResult> {
  const callableContext = await loadCallableContext(symbol, state);
  if (!callableContext) {
    return { env: initialEnv, return_paths: [] };
  }

  const bodyNode = callableContext.node.childForFieldName("body");
  if (!bodyNode) {
    return { env: initialEnv, return_paths: [] };
  }

  return await analyzeBlock(bodyNode, symbol, initialEnv, state, context);
}

function shouldAnalyzeSymbol(symbol: CodeSymbol, filePattern?: string): boolean {
  if (!symbol.file.endsWith(".py")) return false;
  if (filePattern && !symbol.file.includes(filePattern)) return false;
  if (!symbol.source) return false;
  if (symbol.kind !== "function" && symbol.kind !== "method") return false;
  return hasPotentialSource(symbol) || hasPotentialSink(symbol);
}

export { analyzeCallableSymbol, shouldAnalyzeSymbol };
