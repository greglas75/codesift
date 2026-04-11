/**
 * Kotlin-specific analysis tools.
 *
 * find_extension_functions  — discover all extension functions for a receiver type
 * analyze_sealed_hierarchy  — find subtypes and missing when() branches
 * trace_suspend_chain       — suspend call chain + dispatcher + blocking anti-patterns
 * analyze_kmp_declarations  — match expect/actual across KMP source sets
 */
import { getCodeIndex } from "./index-tools.js";
import type { CodeSymbol } from "../types.js";

// ---------------------------------------------------------------------------
// find_extension_functions
// ---------------------------------------------------------------------------

export interface ExtensionFunctionResult {
  receiver_type: string;
  extensions: Array<{
    name: string;
    file: string;
    start_line: number;
    signature?: string;
    docstring?: string;
  }>;
  total: number;
}

/**
 * Find all extension functions defined for a given receiver type.
 * Scans Kotlin symbol signatures for the `ReceiverType.` prefix pattern.
 */
export async function findExtensionFunctions(
  repo: string,
  receiverType: string,
  options?: { file_pattern?: string },
): Promise<ExtensionFunctionResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const pattern = `${receiverType}.`;
  const extensions: ExtensionFunctionResult["extensions"] = [];

  for (const sym of index.symbols) {
    if (sym.kind !== "function") continue;
    if (!sym.signature) continue;
    if (options?.file_pattern && !sym.file.includes(options.file_pattern)) continue;

    // Match receiver type in signature — look for "ReceiverType." prefix
    // Signatures look like: "String.(param: Int): Boolean" or "suspend List<T>.(x: T): T"
    // Strip leading "suspend " for matching
    const sig = sym.signature.replace(/^suspend\s+/, "");
    // Check for exact type match or generic match (e.g., "List<T>." matches "List")
    if (sig.startsWith(pattern) || sig.startsWith(`${receiverType}<`)) {
      extensions.push({
        name: sym.name,
        file: sym.file,
        start_line: sym.start_line,
        ...(sym.signature ? { signature: sym.signature } : {}),
        ...(sym.docstring ? { docstring: sym.docstring } : {}),
      });
    }
  }

  // Sort by file then line for stable output
  extensions.sort((a, b) => a.file.localeCompare(b.file) || a.start_line - b.start_line);

  return {
    receiver_type: receiverType,
    extensions,
    total: extensions.length,
  };
}

// ---------------------------------------------------------------------------
// analyze_sealed_hierarchy
// ---------------------------------------------------------------------------

export interface SealedHierarchyResult {
  sealed_class: {
    name: string;
    file: string;
    start_line: number;
    kind: string;
  };
  subtypes: Array<{
    name: string;
    file: string;
    start_line: number;
    kind: string;
  }>;
  when_blocks: Array<{
    file: string;
    line: number;
    branches_found: string[];
    branches_missing: string[];
    is_exhaustive: boolean;
  }>;
  total_subtypes: number;
  total_when_blocks: number;
  all_exhaustive: boolean;
}

/**
 * Analyze a sealed class/interface hierarchy.
 * Finds all subtypes and checks when() blocks for exhaustiveness.
 */
export async function analyzeSealedHierarchy(
  repo: string,
  sealedClassName: string,
): Promise<SealedHierarchyResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  // Find the sealed class/interface
  const sealedSym = index.symbols.find(
    (s) =>
      s.name === sealedClassName &&
      (s.kind === "class" || s.kind === "interface") &&
      s.source?.includes("sealed"),
  );

  if (!sealedSym) {
    throw new Error(
      `Sealed class/interface "${sealedClassName}" not found. Ensure the file is indexed.`,
    );
  }

  // Find subtypes — classes whose source contains `: SealedName` or `: SealedName()`
  // as a delegation specifier (supertype)
  const subtypePattern = new RegExp(
    `:\\s*(?:[\\w<>,\\s]+,\\s*)?${sealedClassName}\\s*[({,)]|:\\s*${sealedClassName}\\s*$`,
  );

  const subtypes: SealedHierarchyResult["subtypes"] = [];
  for (const sym of index.symbols) {
    if (sym.kind !== "class" && sym.kind !== "interface") continue;
    if (sym.name === sealedClassName) continue;
    if (!sym.source) continue;

    if (subtypePattern.test(sym.source)) {
      subtypes.push({
        name: sym.name,
        file: sym.file,
        start_line: sym.start_line,
        kind: sym.kind,
      });
    }
  }

  const subtypeNames = new Set(subtypes.map((s) => s.name));

  // Find when() blocks that reference the sealed class
  // Search for `when (expr)` patterns in Kotlin files where expr involves the sealed type
  const whenBlocks: SealedHierarchyResult["when_blocks"] = [];

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const kotlinFiles = index.files.filter((f) => /\.kts?$/.test(f.path));

  for (const file of kotlinFiles) {
    let source: string;
    try {
      source = await readFile(join(index.root, file.path), "utf-8");
    } catch {
      continue;
    }

    // Find when blocks — look for `when (` or `when {` patterns
    const whenPattern = /\bwhen\s*\([^)]*\)\s*\{/g;
    let match: RegExpExecArray | null;

    while ((match = whenPattern.exec(source)) !== null) {
      // Check if this when block references any of the subtypes
      // Extract the block content (approximate — find matching closing brace)
      const blockStart = match.index + match[0].length;
      let depth = 1;
      let blockEnd = blockStart;
      for (let i = blockStart; i < source.length && depth > 0; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
        blockEnd = i;
      }

      const blockContent = source.slice(match.index, blockEnd + 1);

      // Check if this when block references our sealed class subtypes
      const branchesFound: string[] = [];
      for (const subName of subtypeNames) {
        // Match: `is SubName ->` or `SubName ->` or `is SubName,`
        const branchRe = new RegExp(`\\b(?:is\\s+)?${subName}\\b`);
        if (branchRe.test(blockContent)) {
          branchesFound.push(subName);
        }
      }

      // Only report when blocks that reference at least one subtype
      if (branchesFound.length === 0) continue;

      const branchesMissing = [...subtypeNames].filter(
        (n) => !branchesFound.includes(n),
      );

      const lineNum =
        source.slice(0, match.index).split("\n").length;

      whenBlocks.push({
        file: file.path,
        line: lineNum,
        branches_found: branchesFound.sort(),
        branches_missing: branchesMissing.sort(),
        is_exhaustive: branchesMissing.length === 0,
      });
    }
  }

  return {
    sealed_class: {
      name: sealedSym.name,
      file: sealedSym.file,
      start_line: sealedSym.start_line,
      kind: sealedSym.kind,
    },
    subtypes,
    when_blocks: whenBlocks,
    total_subtypes: subtypes.length,
    total_when_blocks: whenBlocks.length,
    all_exhaustive: whenBlocks.length > 0 && whenBlocks.every((w) => w.is_exhaustive),
  };
}

// ---------------------------------------------------------------------------
// trace_suspend_chain
// ---------------------------------------------------------------------------

export interface SuspendDispatcherTransition {
  function: string;
  dispatcher: string;
  line: number;
}

export interface SuspendWarning {
  function: string;
  file: string;
  line: number;
  message: string;
  severity: "warning" | "critical";
}

export interface SuspendChainResult {
  root: string;
  chain: string[];
  dispatcher_transitions: SuspendDispatcherTransition[];
  warnings: SuspendWarning[];
  depth: number;
}

/**
 * Normalize a dispatcher expression captured from `withContext(<arg>)` into
 * one of the canonical bucket names: "IO", "Main", "Default", "Unconfined",
 * or a raw string for unrecognized custom dispatchers.
 *
 * Handles three real-world forms, matching the most common Android Kotlin
 * patterns:
 *
 *   Dispatchers.IO        →  "IO"       (static, kotlinx.coroutines canonical)
 *   dispatchers.io        →  "IO"       (DI-injected provider, Google-recommended)
 *   ioDispatcher          →  "IO"       (injected by parameter convention)
 *   mainDispatcher        →  "Main"
 *   defaultDispatcher     →  "Default"
 *
 * Returns null for expressions that don't look like a dispatcher at all
 * (e.g. `coroutineContext` or a plain variable that isn't dispatcher-named),
 * so they don't clutter the transitions report with false positives.
 */
function classifyDispatcherExpression(expr: string): string | null {
  // 1. Static Dispatchers.X (any case on the suffix — canonical is PascalCase)
  const staticMatch = /^Dispatchers\.(\w+)$/.exec(expr);
  if (staticMatch) return canonicalizeDispatcherName(staticMatch[1]!);

  // 2. Injected provider field — `<identifier>.<bucket>` where identifier is
  //    lowercase (e.g. dispatchers.io, coroutineDispatchers.main). We only
  //    accept recognized bucket suffixes so plain `foo.bar` isn't misreported.
  const fieldMatch = /^[a-z]\w*\.(io|main|default|unconfined)$/i.exec(expr);
  if (fieldMatch) return canonicalizeDispatcherName(fieldMatch[1]!);

  // 3. Naming convention — `<bucket>Dispatcher` as a bare parameter.
  const conventionMatch = /^(io|main|default|unconfined)Dispatcher$/i.exec(expr);
  if (conventionMatch) return canonicalizeDispatcherName(conventionMatch[1]!);

  return null;
}

function canonicalizeDispatcherName(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === "io") return "IO";
  if (lower === "main" || lower === "mainimmediate") return "Main";
  if (lower === "default") return "Default";
  if (lower === "unconfined") return "Unconfined";
  // Preserve the original capitalization for anything we don't recognize.
  return raw;
}

/**
 * Determines whether a symbol is a suspend function. Checks the signature
 * prefix first (populated by the Kotlin extractor for extension funcs) then
 * falls back to scanning the source head for the `suspend` modifier keyword.
 */
function isSuspendFunction(sym: CodeSymbol): boolean {
  if (sym.kind !== "function" && sym.kind !== "method") return false;
  if (sym.signature?.startsWith("suspend")) return true;
  const head = sym.source?.slice(0, 200);
  if (!head) return false;
  return /\bsuspend\s+fun\b/.test(head);
}

/**
 * Scan a suspend function's source for common Kotlin coroutine anti-patterns.
 * Returns an array of warnings (one per finding) plus the dispatcher
 * transitions observed in the same pass.
 */
function analyzeSuspendBody(
  sym: CodeSymbol,
): { warnings: SuspendWarning[]; transitions: SuspendDispatcherTransition[] } {
  const warnings: SuspendWarning[] = [];
  const transitions: SuspendDispatcherTransition[] = [];

  const source = sym.source ?? "";
  const fnName = sym.name;

  // Dispatcher transitions. We match any `withContext(<arg>)` and then
  // classify the argument into one of Kotlin's canonical dispatcher buckets.
  // This covers three real-world patterns:
  //
  //   1. Static:       withContext(Dispatchers.IO)
  //   2. DI provider:  withContext(dispatchers.io) — injected CoroutineDispatchers
  //   3. Convention:   withContext(ioDispatcher) / withContext(mainDispatcher)
  //
  // Pattern 2/3 are the Google-recommended testable forms and appear in most
  // production Android Kotlin code. Restricting to `Dispatchers.X` would miss
  // the majority of real-world usage.
  const dispatcherRe = /withContext\s*\(\s*([A-Za-z_][\w.]*)\s*[,)]/g;
  let m: RegExpExecArray | null;
  while ((m = dispatcherRe.exec(source)) !== null) {
    const arg = m[1]!;
    const kind = classifyDispatcherExpression(arg);
    if (!kind) continue; // Not a recognizable dispatcher expression.
    const lineOffset = source.slice(0, m.index).split("\n").length - 1;
    transitions.push({
      function: fnName,
      dispatcher: kind,
      line: sym.start_line + lineOffset,
    });
  }

  // Anti-pattern 1: runBlocking inside a suspend function.
  const runBlockingMatch = /\brunBlocking\s*[\{(]/.exec(source);
  if (runBlockingMatch) {
    const lineOffset = source.slice(0, runBlockingMatch.index).split("\n").length - 1;
    warnings.push({
      function: fnName,
      file: sym.file,
      line: sym.start_line + lineOffset,
      message: "runBlocking inside a suspend function — deadlock risk on caller's dispatcher",
      severity: "critical",
    });
  }

  // Anti-pattern 2: Thread.sleep() blocks the coroutine thread.
  const threadSleepMatch = /\bThread\.sleep\s*\(/.exec(source);
  if (threadSleepMatch) {
    const lineOffset = source.slice(0, threadSleepMatch.index).split("\n").length - 1;
    warnings.push({
      function: fnName,
      file: sym.file,
      line: sym.start_line + lineOffset,
      message: "Thread.sleep() in suspend function — blocks dispatcher thread, use delay() instead",
      severity: "critical",
    });
  }

  // Anti-pattern 3: while(true) loop without ensureActive()/isActive check
  // means the coroutine can't be cancelled.
  const whileTrueMatch = /\bwhile\s*\(\s*true\s*\)\s*\{([\s\S]*?)\}/.exec(source);
  if (whileTrueMatch) {
    const body = whileTrueMatch[1] ?? "";
    const hasCancellationCheck =
      /\bensureActive\s*\(/.test(body) ||
      /\bisActive\b/.test(body) ||
      /\bcoroutineContext\.isActive\b/.test(body);
    if (!hasCancellationCheck) {
      const lineOffset = source.slice(0, whileTrueMatch.index).split("\n").length - 1;
      warnings.push({
        function: fnName,
        file: sym.file,
        line: sym.start_line + lineOffset,
        message:
          "while(true) loop without ensureActive()/isActive — loop is not cancellable, coroutine will leak",
        severity: "warning",
      });
    }
  }

  return { warnings, transitions };
}

/**
 * Trace the suspend function call chain starting from `functionName`. Walks
 * out up to `depth` levels through callees (identified by text scan of the
 * source), filtering to suspend-only nodes. Emits dispatcher transitions and
 * coroutine anti-pattern warnings for each visited function.
 *
 * Walk strategy: we look up each callee name in the symbol index. When a
 * function body contains `otherFn(`, we recurse into the symbol named
 * `otherFn` if it exists and is a suspend function. This is intentionally
 * lexical (not call-graph) — accurate enough for typical coroutine code and
 * avoids a full graph build.
 */
export async function traceSuspendChain(
  repo: string,
  functionName: string,
  options?: { depth?: number },
): Promise<SuspendChainResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const maxDepth = options?.depth ?? 3;

  const root = index.symbols.find(
    (s) => s.name === functionName && (s.kind === "function" || s.kind === "method"),
  );
  if (!root) {
    throw new Error(`Suspend function "${functionName}" not found.`);
  }
  if (!isSuspendFunction(root)) {
    throw new Error(`"${functionName}" is not a suspend function.`);
  }

  // Pre-index suspend functions by name for O(1) callee lookup.
  const suspendByName = new Map<string, CodeSymbol>();
  for (const sym of index.symbols) {
    if (isSuspendFunction(sym)) suspendByName.set(sym.name, sym);
  }

  const chain: string[] = [];
  const visited = new Set<string>();
  const allWarnings: SuspendWarning[] = [];
  const allTransitions: SuspendDispatcherTransition[] = [];

  function walk(sym: CodeSymbol, level: number): void {
    if (visited.has(sym.id) || level > maxDepth) return;
    visited.add(sym.id);
    chain.push(sym.name);

    const { warnings, transitions } = analyzeSuspendBody(sym);
    allWarnings.push(...warnings);
    allTransitions.push(...transitions);

    if (level === maxDepth) return;

    // Lexical callee discovery: find identifiers followed by ( in the body
    // and follow them if they map to a known suspend function.
    const source = sym.source ?? "";
    const callRe = /\b([a-z]\w*)\s*\(/g;
    const calleesSeen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(source)) !== null) {
      const name = m[1]!;
      if (name === sym.name || calleesSeen.has(name)) continue;
      calleesSeen.add(name);
      const callee = suspendByName.get(name);
      if (callee && callee.id !== sym.id) walk(callee, level + 1);
    }
  }

  walk(root, 0);

  return {
    root: root.name,
    chain,
    dispatcher_transitions: allTransitions,
    warnings: allWarnings,
    depth: maxDepth,
  };
}

// ---------------------------------------------------------------------------
// analyze_kmp_declarations — Kotlin Multiplatform expect/actual validation
// ---------------------------------------------------------------------------

export interface KmpMatchedDeclaration {
  name: string;
  kind: string;
  expect_source_set: string;
  actual_source_sets: string[];
}

export interface KmpMissingDeclaration {
  name: string;
  kind: string;
  source_set: string;
  missing_from: string[];
}

export interface KmpOrphanDeclaration {
  name: string;
  kind: string;
  source_set: string;
  file: string;
}

export interface KmpAnalysisResult {
  total_expects: number;
  fully_matched: number;
  source_sets_detected: string[];
  matched: KmpMatchedDeclaration[];
  missing_actuals: KmpMissingDeclaration[];
  orphan_actuals: KmpOrphanDeclaration[];
}

/**
 * Parse the source set segment from a KMP-layout file path. Returns the
 * source set name (e.g. "commonMain", "androidMain") or null when the file
 * isn't under a recognized `src/<name>Main/kotlin/` layout.
 */
function parseSourceSet(filePath: string): string | null {
  const match = /src\/(\w+Main)\/kotlin\//.exec(filePath);
  return match?.[1] ?? null;
}

/**
 * Analyze KMP expect/actual declarations across source sets. Groups symbols
 * tagged with `meta.kmp_modifier` by simple name, splits them into expects
 * and actuals, and reports three verdicts per declaration:
 *
 *   - matched:         commonMain expect + at least one platform actual
 *   - missing_actuals: commonMain expect but one or more platform source
 *                      sets (discovered from the index files list) have no
 *                      corresponding `actual`
 *   - orphan_actuals:  actual without any commonMain expect
 */
export async function analyzeKmpDeclarations(
  repo: string,
): Promise<KmpAnalysisResult> {
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  // Discover all source sets present in the repo (from file paths) so we can
  // compute missing_actuals against the ones that actually exist. Fallback
  // list covers the common KMP targets when source sets can't be detected
  // from the files array.
  const sourceSetsInRepo = new Set<string>();
  for (const file of index.files) {
    const sourceSet = parseSourceSet(file.path);
    if (sourceSet) sourceSetsInRepo.add(sourceSet);
  }
  // Drop commonMain from the "platforms to check" list — commonMain holds
  // expects, not actuals.
  const platformSourceSets = [...sourceSetsInRepo].filter(
    (s) => s !== "commonMain",
  );

  // Group KMP-tagged symbols by simple name + kind so a class and a function
  // with the same name don't cross-contaminate.
  interface Grouped {
    expects: Array<{ sym: CodeSymbol; sourceSet: string }>;
    actuals: Array<{ sym: CodeSymbol; sourceSet: string }>;
  }
  const groups = new Map<string, Grouped>();

  for (const sym of index.symbols) {
    const kmp = sym.meta?.["kmp_modifier"];
    if (kmp !== "expect" && kmp !== "actual") continue;
    const sourceSet = parseSourceSet(sym.file);
    if (!sourceSet) continue;

    const key = `${sym.kind}::${sym.name}`;
    let group = groups.get(key);
    if (!group) {
      group = { expects: [], actuals: [] };
      groups.set(key, group);
    }
    if (kmp === "expect") {
      group.expects.push({ sym, sourceSet });
    } else {
      group.actuals.push({ sym, sourceSet });
    }
  }

  const matched: KmpMatchedDeclaration[] = [];
  const missingActuals: KmpMissingDeclaration[] = [];
  const orphanActuals: KmpOrphanDeclaration[] = [];
  let fullyMatched = 0;

  for (const group of groups.values()) {
    if (group.expects.length === 0) {
      // All entries are actuals with no expect → orphans.
      for (const { sym, sourceSet } of group.actuals) {
        orphanActuals.push({
          name: sym.name,
          kind: sym.kind,
          source_set: sourceSet,
          file: sym.file,
        });
      }
      continue;
    }

    // A group has an expect. Walk each expect (usually just one from
    // commonMain) and check actuals.
    for (const expectEntry of group.expects) {
      const actualSets = group.actuals.map((a) => a.sourceSet);
      const missingFrom = platformSourceSets.filter(
        (s) => !actualSets.includes(s),
      );

      if (missingFrom.length === 0 && actualSets.length > 0) {
        fullyMatched++;
      }

      if (actualSets.length > 0) {
        matched.push({
          name: expectEntry.sym.name,
          kind: expectEntry.sym.kind,
          expect_source_set: expectEntry.sourceSet,
          actual_source_sets: actualSets,
        });
      }

      if (missingFrom.length > 0) {
        missingActuals.push({
          name: expectEntry.sym.name,
          kind: expectEntry.sym.kind,
          source_set: expectEntry.sourceSet,
          missing_from: missingFrom,
        });
      }
    }
  }

  return {
    total_expects: [...groups.values()].reduce((n, g) => n + g.expects.length, 0),
    fully_matched: fullyMatched,
    source_sets_detected: [...sourceSetsInRepo].sort(),
    matched,
    missing_actuals: missingActuals,
    orphan_actuals: orphanActuals,
  };
}
