import { describe, expect, it } from "vitest";
import * as facade from "../../src/tools/symbol-tools.js";
import * as analysis from "../../src/tools/symbol-analysis-tools.js";
import * as context from "../../src/tools/symbol-context-tools.js";
import * as lookup from "../../src/tools/symbol-lookup-tools.js";
import * as references from "../../src/tools/symbol-reference-tools.js";
import type {
  ContextBundle,
  DeadCodeCandidate,
  DeadCodeResult,
  ReactContext,
  ReferenceScanCoverage,
  ReferenceScanSink,
  SymbolIdAmbiguity,
  UnusedImport,
  UnusedImportsResult,
} from "../../src/tools/symbol-tools.js";

// Test level: small — module identity only; no I/O, network, timers, or shared state.
describe("symbol-tools public facade", () => {
  it("keeps the complete historical runtime export surface and exposes nothing else", () => {
    expect(Object.keys(facade).sort()).toEqual([
      "AmbiguousSymbolIdError",
      "extractSymbolNameGuess",
      "findAndShow",
      "findDeadCode",
      "findReferences",
      "findReferencesBatch",
      "findSimilarSymbols",
      "findUnusedImports",
      "formatBundleCompact",
      "formatRefsCompact",
      "formatSymbolCompact",
      "formatSymbolsCompact",
      "getContextBundle",
      "getSymbol",
      "getSymbols",
      "isAmbiguousSymbolIdError",
      "resolveSymbolIdExact",
    ]);
  });

  it.each([
    ["AmbiguousSymbolIdError", lookup.AmbiguousSymbolIdError],
    ["extractSymbolNameGuess", lookup.extractSymbolNameGuess],
    ["findSimilarSymbols", lookup.findSimilarSymbols],
    ["getSymbol", lookup.getSymbol],
    ["getSymbols", lookup.getSymbols],
    ["isAmbiguousSymbolIdError", lookup.isAmbiguousSymbolIdError],
    ["resolveSymbolIdExact", lookup.resolveSymbolIdExact],
    ["findReferences", references.findReferences],
    ["findReferencesBatch", references.findReferencesBatch],
    ["findAndShow", context.findAndShow],
    ["formatBundleCompact", context.formatBundleCompact],
    ["formatRefsCompact", context.formatRefsCompact],
    ["formatSymbolCompact", context.formatSymbolCompact],
    ["formatSymbolsCompact", context.formatSymbolsCompact],
    ["getContextBundle", context.getContextBundle],
    ["findDeadCode", analysis.findDeadCode],
    ["findUnusedImports", analysis.findUnusedImports],
  ] as const)("preserves %s as the same runtime export", (name, implementation) => {
    expect(facade[name]).toBe(implementation);
  });

  it("keeps historical type exports reachable from the facade", () => {
    const ambiguity: SymbolIdAmbiguity = { status: "unique" };
    const coverage: ReferenceScanCoverage = {
      status: "complete",
      files_indexed: 1,
      files_scanned: 1,
    };
    const coverageSink: ReferenceScanSink = { coverage };
    const reactContext: ReactContext = {
      props_type: null,
      props_interface_source: null,
      hooks_used: [],
      child_components: [],
      parent_components: [],
      wrapper: null,
    };
    const deadCodeCandidate: DeadCodeCandidate = {
      name: "unusedExport",
      kind: "function",
      file: "src/example.ts",
      start_line: 1,
      end_line: 2,
      reason: "no references",
    };
    const unusedImport: UnusedImport = {
      file: "src/example.ts",
      line: 1,
      import_text: 'import { unused } from "./dependency.js";',
      imported_name: "unused",
    };
    const contextBundle = null as ContextBundle | null;
    const deadCode = null as DeadCodeResult | null;
    const unusedImports = null as UnusedImportsResult | null;

    expect({
      ambiguity,
      coverage,
      coverageSink,
      reactContext,
      deadCodeCandidate,
      unusedImport,
      contextBundle,
      deadCode,
      unusedImports,
    }).toEqual({
      ambiguity: { status: "unique" },
      coverage: { status: "complete", files_indexed: 1, files_scanned: 1 },
      coverageSink: {
        coverage: { status: "complete", files_indexed: 1, files_scanned: 1 },
      },
      reactContext: {
        props_type: null,
        props_interface_source: null,
        hooks_used: [],
        child_components: [],
        parent_components: [],
        wrapper: null,
      },
      deadCodeCandidate: {
        name: "unusedExport",
        kind: "function",
        file: "src/example.ts",
        start_line: 1,
        end_line: 2,
        reason: "no references",
      },
      unusedImport: {
        file: "src/example.ts",
        line: 1,
        import_text: 'import { unused } from "./dependency.js";',
        imported_name: "unused",
      },
      contextBundle: null,
      deadCode: null,
      unusedImports: null,
    });
  });
});
