import type { CodeSymbol } from "../../types.js";
import type {
  ConstantResolutionMatch,
  ResolutionState,
} from "./model.js";
import { computeConfidence } from "./syntax.js";
import { resolveNamedValue } from "./value-resolver.js";

async function resolveConstantSymbol(
  symbol: CodeSymbol,
  state: ResolutionState,
): Promise<ConstantResolutionMatch> {
  const result = await resolveNamedValue(symbol.file, symbol.name, state, 0);
  const match: ConstantResolutionMatch = {
    symbol_name: symbol.name,
    symbol_kind: symbol.kind,
    file: symbol.file,
    line: symbol.start_line,
    resolved: result.resolved,
    value_text: result.value_text,
    confidence: computeConfidence(result.resolved, result.alias_chain, result.used_import),
    alias_chain: result.alias_chain,
  };
  if (result.value_kind !== undefined) match.value_kind = result.value_kind;
  if (result.value !== undefined) match.value = result.value;
  if (result.reason !== undefined) match.reason = result.reason;
  return match;
}

export { resolveConstantSymbol };
