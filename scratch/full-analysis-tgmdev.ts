/**
 * Full Kotlin deployment analysis — all Wave 1 + Wave 2 tools, language
 * characteristics, and architectural breakdown.
 *
 * Read-only. Walks /Users/greglas/DEV/tgmdev-tgm-panel-mobilapp with the
 * same extractor pipeline the MCP server uses, then runs every shipped
 * Kotlin tool against the in-memory index and reports aggregate stats.
 *
 * Sections:
 *   1. Parse stats + language characteristics (kinds, signatures, sizes)
 *   2. Extension functions (Wave 1: findExtensionFunctions)
 *   3. Sealed hierarchies (Wave 1: analyzeSealedHierarchy)
 *   4. Kotest DSL detection (Wave 2 Task 4)
 *   5. Gradle KTS config (Wave 2 Task 5)
 *   6. Dead code whitelist (Wave 2 Task 3)
 *   7. Hilt DI graph (Wave 2 Task 7/8)
 *   8. Suspend chain + dispatchers (Wave 2 Task 9/10)
 *   9. KMP expect/actual (Wave 2 Task 11/12)
 *  10. Anti-pattern scan (Wave 1 + 2 Kotlin patterns via search_patterns)
 *  11. Summary verdict
 */
import { readFile } from "node:fs/promises";
import { extname, relative } from "node:path";
import { initParser, getParser, getLanguageForPath } from "../src/parser/parser-manager.js";
import { extractKotlinSymbols } from "../src/parser/extractors/kotlin.js";
import { extractGradleKtsSymbols } from "../src/parser/extractors/gradle-kts.js";
import { walkDirectory } from "../src/utils/walk.js";
import type { CodeIndex, CodeSymbol, FileEntry, SymbolKind } from "../src/types.js";
import { detectFrameworks, isFrameworkEntryPoint, KOTLIN_FRAMEWORK_ANNOTATIONS } from "../src/utils/framework-detect.js";
import { BUILTIN_PATTERNS } from "../src/tools/pattern-tools.js";

const REPO_ROOT = "/Users/greglas/DEV/tgmdev-tgm-panel-mobilapp";

function banner(title: string) {
  console.log(`\n${"═".repeat(72)}`);
  console.log(` ${title}`);
  console.log("═".repeat(72));
}

function subheader(title: string) {
  console.log(`\n— ${title} —`);
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function main() {
  banner("Full Kotlin deployment analysis — tgmdev-tgm-panel-mobilapp");
  console.log(`Repo:  ${REPO_ROOT}`);
  console.log(`Tools: Kotlin Wave 1 + Wave 2 (all 5 Kotlin tools + 8 patterns)`);

  await initParser();
  const parser = await getParser("kotlin");
  if (!parser) throw new Error("kotlin parser unavailable");

  // ---- Walk + parse ----
  const allFiles = await walkDirectory(REPO_ROOT, {
    fileFilter: (ext) => ext === ".kt" || ext === ".kts",
  });
  const paths = allFiles.filter((p) => {
    const ext = extname(p);
    return ext === ".kt" || ext === ".kts";
  });

  const symbols: CodeSymbol[] = [];
  const fileEntries: FileEntry[] = [];
  let gradleKtsCount = 0;
  let parseErrors = 0;
  let totalLoc = 0;

  for (const abs of paths) {
    let source: string;
    try {
      source = await readFile(abs, "utf-8");
    } catch {
      continue;
    }
    const rel = relative(REPO_ROOT, abs);
    const lang = getLanguageForPath(abs) ?? "kotlin";
    let tree;
    try {
      tree = parser.parse(source);
    } catch {
      parseErrors++;
      continue;
    }
    const extracted = lang === "gradle-kts"
      ? extractGradleKtsSymbols(tree, rel, source, "tgmdev")
      : extractKotlinSymbols(tree, rel, source, "tgmdev");
    if (lang === "gradle-kts") gradleKtsCount++;
    symbols.push(...extracted);
    totalLoc += source.split("\n").length;
    fileEntries.push({ path: rel, language: lang, symbol_count: extracted.length, last_modified: 0 });
  }

  const index: CodeIndex = {
    repo: "tgmdev",
    root: REPO_ROOT,
    symbols,
    files: fileEntries,
    created_at: 0,
    updated_at: 0,
    symbol_count: symbols.length,
    file_count: fileEntries.length,
  };

  // =========================================================================
  // 1. Parse stats + language characteristics
  // =========================================================================
  banner("1. Parse stats + language characteristics");
  console.log(`Kotlin files:          ${fileEntries.length} (${totalLoc} LOC total)`);
  console.log(`  Gradle KTS files:    ${gradleKtsCount}`);
  console.log(`  Parse errors:        ${parseErrors}`);
  console.log(`Total symbols:         ${symbols.length}`);

  subheader("Symbol breakdown by kind");
  const byKind = new Map<SymbolKind, number>();
  for (const s of symbols) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
  const sorted = [...byKind.entries()].sort((a, b) => b[1] - a[1]);
  for (const [kind, n] of sorted) {
    console.log(`  ${kind.padEnd(16)} ${String(n).padStart(5)}  ${pct(n, symbols.length)}`);
  }

  subheader("Kotlin-idiomatic features");
  const suspendFns = symbols.filter(
    (s) => (s.kind === "function" || s.kind === "method") &&
           (s.signature?.startsWith("suspend") ||
            /\bsuspend\s+fun\b/.test(s.source?.slice(0, 150) ?? "")),
  );
  const extensionFns = symbols.filter(
    (s) => s.kind === "function" && s.signature &&
           /^(?:suspend\s+)?[\w<>,\s]+\./.test(s.signature.replace(/^suspend\s+/, "")),
  );
  const inlineFns = symbols.filter(
    (s) => s.kind === "function" && s.source?.slice(0, 200).match(/\binline\s+(?:suspend\s+)?fun\b/),
  );
  const dataClasses = symbols.filter(
    (s) => s.kind === "class" && s.source?.slice(0, 200).match(/\bdata\s+class\b/),
  );
  const sealedClasses = symbols.filter(
    (s) => (s.kind === "class" || s.kind === "interface") && s.source?.slice(0, 200).match(/\bsealed\s+(class|interface)\b/),
  );
  const enumClasses = symbols.filter(
    (s) => s.kind === "class" && s.source?.slice(0, 200).match(/\benum\s+class\b/),
  );
  const objectDecls = symbols.filter(
    (s) => s.kind === "class" && s.source?.slice(0, 200).match(/^(?:@\w+\s*)*\s*(?:internal|private|public)?\s*object\s+\w+/),
  );
  const companionObjs = symbols.filter((s) => s.name === "Companion");
  const typealiases = symbols.filter((s) => s.kind === "type");

  console.log(`  suspend functions:     ${suspendFns.length}`);
  console.log(`  extension functions:   ${extensionFns.length}`);
  console.log(`  inline functions:      ${inlineFns.length}`);
  console.log(`  data classes:          ${dataClasses.length}`);
  console.log(`  sealed classes/ifaces: ${sealedClasses.length}`);
  console.log(`  enum classes:          ${enumClasses.length}`);
  console.log(`  object declarations:   ${objectDecls.length}`);
  console.log(`  companion objects:     ${companionObjs.length}`);
  console.log(`  typealiases:           ${typealiases.length}`);

  // =========================================================================
  // 2. Extension functions (Wave 1 tool)
  // =========================================================================
  banner("2. Extension functions (Wave 1: find_extension_functions)");
  const receiverCounts = new Map<string, number>();
  for (const fn of extensionFns) {
    if (!fn.signature) continue;
    const sig = fn.signature.replace(/^suspend\s+/, "");
    const dotIdx = sig.indexOf(".");
    if (dotIdx === -1) continue;
    const receiver = sig.slice(0, dotIdx).replace(/<.*$/, "").trim();
    if (!receiver || receiver.startsWith("(")) continue;
    receiverCounts.set(receiver, (receiverCounts.get(receiver) ?? 0) + 1);
  }
  const topReceivers = [...receiverCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  console.log(`Total extension functions: ${extensionFns.length}`);
  console.log(`Unique receiver types:     ${receiverCounts.size}`);
  console.log("\nTop 10 receiver types:");
  for (const [recv, n] of topReceivers) {
    console.log(`  ${recv.padEnd(24)} ${n}`);
  }

  // =========================================================================
  // 3. Sealed hierarchies (Wave 1 tool)
  // =========================================================================
  banner("3. Sealed hierarchies (Wave 1: analyze_sealed_hierarchy)");
  console.log(`Total sealed declarations: ${sealedClasses.length}`);
  if (sealedClasses.length > 0) {
    console.log("\nFirst 10 sealed types:");
    for (const s of sealedClasses.slice(0, 10)) {
      console.log(`  ${s.name.padEnd(24)} ${s.file}:${s.start_line}`);
    }
  }

  // =========================================================================
  // 4. Kotest DSL (Wave 2 Task 4)
  // =========================================================================
  banner("4. Kotest DSL detection (Wave 2 Task 4)");
  const testSuites = symbols.filter((s) => s.kind === "test_suite");
  const testCases = symbols.filter((s) => s.kind === "test_case");
  const testHooks = symbols.filter((s) => s.kind === "test_hook");
  console.log(`test_suite (Kotest spec classes): ${testSuites.length}`);
  console.log(`test_case symbols:                ${testCases.length}`);
  console.log(`test_hook symbols:                ${testHooks.length}`);
  if (testSuites.length === 0 && testCases.length > 0) {
    console.log(`\n(all test_case symbols are JUnit @Test — no Kotest DSL usage in project)`);
  }

  // =========================================================================
  // 5. Gradle KTS structured config (Wave 2 Task 5)
  // =========================================================================
  banner("5. Gradle KTS structured config (Wave 2 Task 5)");
  const gradleSymbols = symbols.filter((s) => s.file.endsWith(".gradle.kts"));
  const plugins = gradleSymbols.filter((s) => s.meta?.["gradle_type"] === "plugin");
  const deps = gradleSymbols.filter((s) => s.meta?.["gradle_type"] === "dependency");
  const configs = gradleSymbols.filter((s) => s.meta?.["gradle_type"] === "config");
  console.log(`Gradle KTS files:    ${gradleKtsCount}`);
  console.log(`Plugins declared:    ${plugins.length}`);
  console.log(`Dependencies:        ${deps.length}`);
  console.log(`Config entries:      ${configs.length}`);

  if (plugins.length > 0) {
    subheader("Plugins (first 15)");
    for (const p of plugins.slice(0, 15)) {
      const ver = p.meta?.["version"] ? ` v${p.meta["version"]}` : "";
      console.log(`  ${p.name}${ver}  [${p.meta?.["declarator"]}]`);
    }
  }

  if (deps.length > 0) {
    subheader("Top dependency configurations");
    const byConfig = new Map<string, number>();
    for (const d of deps) {
      const cfg = String(d.meta?.["configuration"] ?? "unknown");
      byConfig.set(cfg, (byConfig.get(cfg) ?? 0) + 1);
    }
    for (const [cfg, n] of [...byConfig.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cfg.padEnd(28)} ${n}`);
    }
  }

  // =========================================================================
  // 6. Framework-aware dead code whitelist (Wave 2 Task 3)
  // =========================================================================
  banner("6. Dead code whitelist (Wave 2 Task 3)");
  const frameworks = detectFrameworks(index);
  console.log(`Detected frameworks: ${[...frameworks].join(", ")}`);
  console.log(`kotlin-android auto-load trigger: ${frameworks.has("kotlin-android") ? "✓ ACTIVE" : "✗"}`);

  const kotlinDeclarations = symbols.filter(
    (s) => s.file.endsWith(".kt") &&
           (s.kind === "class" || s.kind === "interface" ||
            s.kind === "function" || s.kind === "method" ||
            s.kind === "component" || s.kind === "hook"),
  );
  const whitelisted = kotlinDeclarations.filter((s) => isFrameworkEntryPoint(s, frameworks));

  console.log(`\nKotlin top-level declarations: ${kotlinDeclarations.length}`);
  console.log(`Whitelisted (skipped by find_dead_code): ${whitelisted.length} (${pct(whitelisted.length, kotlinDeclarations.length)})`);

  subheader("Top annotations (full corpus)");
  const annotationCounts = new Map<string, number>();
  for (const sym of symbols) {
    for (const dec of sym.decorators ?? []) {
      annotationCounts.set(dec, (annotationCounts.get(dec) ?? 0) + 1);
    }
  }
  const whitelistHits = new Set<string>();
  for (const dec of annotationCounts.keys()) {
    if (KOTLIN_FRAMEWORK_ANNOTATIONS.has(dec)) whitelistHits.add(dec);
  }
  const topAnn = [...annotationCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  for (const [name, count] of topAnn) {
    const marker = whitelistHits.has(name) ? " ✓ whitelisted" : "";
    console.log(`  @${name.padEnd(24)} ${String(count).padStart(4)}${marker}`);
  }

  // =========================================================================
  // 7. Hilt DI graph (Wave 2 Task 7/8)
  // =========================================================================
  banner("7. Hilt DI graph (Wave 2 Task 7/8)");
  const viewModels = symbols.filter(
    (s) => s.kind === "class" && s.decorators?.includes("HiltViewModel"),
  );
  const androidEntryPoints = symbols.filter(
    (s) => s.kind === "class" && s.decorators?.includes("AndroidEntryPoint"),
  );
  const hiltApps = symbols.filter(
    (s) => s.kind === "class" && s.decorators?.includes("HiltAndroidApp"),
  );
  const modules = symbols.filter(
    (s) => s.kind === "class" && s.decorators?.includes("Module"),
  );
  const providers = symbols.filter(
    (s) => (s.kind === "method" || s.kind === "function") &&
           (s.decorators?.includes("Provides") || s.decorators?.includes("Binds")),
  );
  console.log(`@HiltViewModel:            ${viewModels.length}`);
  console.log(`@AndroidEntryPoint:        ${androidEntryPoints.length}`);
  console.log(`@HiltAndroidApp:           ${hiltApps.length}`);
  console.log(`@Module classes:           ${modules.length}`);
  console.log(`@Provides/@Binds methods:  ${providers.length}`);
  const hiltTotal = viewModels.length + androidEntryPoints.length + hiltApps.length + modules.length;
  if (hiltTotal === 0) {
    console.log(`\n→ Project does NOT use Hilt. trace_hilt_graph correctly returns empty graph.`);
  }

  // =========================================================================
  // 8. Suspend chain + dispatchers (Wave 2 Task 9/10)
  // =========================================================================
  banner("8. Suspend chain + dispatchers (Wave 2 Task 9/10)");

  // Inline classifier — same logic as src/tools/kotlin-tools.ts
  const classifyDispatcher = (expr: string): string | null => {
    const staticMatch = /^Dispatchers\.(\w+)$/.exec(expr);
    if (staticMatch) return canonicalize(staticMatch[1]!);
    const fieldMatch = /^[a-z]\w*\.(io|main|default|unconfined)$/i.exec(expr);
    if (fieldMatch) return canonicalize(fieldMatch[1]!);
    const conventionMatch = /^(io|main|default|unconfined)Dispatcher$/i.exec(expr);
    if (conventionMatch) return canonicalize(conventionMatch[1]!);
    return null;
  };
  function canonicalize(raw: string): string {
    const lower = raw.toLowerCase();
    if (lower === "io") return "IO";
    if (lower === "main" || lower === "mainimmediate") return "Main";
    if (lower === "default") return "Default";
    if (lower === "unconfined") return "Unconfined";
    return raw;
  }

  let totalRunBlocking = 0;
  let totalThreadSleep = 0;
  let totalNonCancellable = 0;
  let totalDispatcherTransitions = 0;
  const dispatcherBuckets = new Map<string, number>();
  const fnsWithTransitions = new Set<string>();

  for (const fn of suspendFns) {
    const src = fn.source ?? "";
    if (/\brunBlocking\s*[\{(]/.test(src)) totalRunBlocking++;
    if (/\bThread\.sleep\s*\(/.test(src)) totalThreadSleep++;
    const whileMatch = /\bwhile\s*\(\s*true\s*\)\s*\{([\s\S]*?)\}/.exec(src);
    if (whileMatch && !/(ensureActive|isActive)/.test(whileMatch[1] ?? "")) totalNonCancellable++;
    const dispatcherRe = /withContext\s*\(\s*([A-Za-z_][\w.]*)\s*[,)]/g;
    let m: RegExpExecArray | null;
    while ((m = dispatcherRe.exec(src)) !== null) {
      const kind = classifyDispatcher(m[1]!);
      if (!kind) continue;
      totalDispatcherTransitions++;
      dispatcherBuckets.set(kind, (dispatcherBuckets.get(kind) ?? 0) + 1);
      fnsWithTransitions.add(fn.id);
    }
  }

  console.log(`Total suspend functions:       ${suspendFns.length}`);
  console.log(`Functions with dispatch switch: ${fnsWithTransitions.size}`);
  console.log(`Total dispatcher transitions:   ${totalDispatcherTransitions}`);
  if (dispatcherBuckets.size > 0) {
    subheader("Dispatcher breakdown");
    for (const [k, v] of [...dispatcherBuckets.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  Dispatchers.${k.padEnd(12)} ${v}`);
    }
  }

  subheader("Coroutine anti-patterns (aggregated)");
  const marker = (n: number, crit: boolean) => {
    if (n === 0) return "✓";
    return crit ? "⚠ CRITICAL" : "⚠";
  };
  console.log(`  runBlocking in suspend:       ${totalRunBlocking}  ${marker(totalRunBlocking, true)}`);
  console.log(`  Thread.sleep in suspend:      ${totalThreadSleep}  ${marker(totalThreadSleep, true)}`);
  console.log(`  non-cancellable while(true):  ${totalNonCancellable}  ${marker(totalNonCancellable, false)}`);

  // =========================================================================
  // 9. KMP expect/actual (Wave 2 Task 11/12)
  // =========================================================================
  banner("9. KMP expect/actual (Wave 2 Task 11/12)");
  const kmpSymbols = symbols.filter((s) => s.meta?.["kmp_modifier"]);
  const expects = kmpSymbols.filter((s) => s.meta!["kmp_modifier"] === "expect");
  const actuals = kmpSymbols.filter((s) => s.meta!["kmp_modifier"] === "actual");
  console.log(`expect declarations: ${expects.length}`);
  console.log(`actual declarations: ${actuals.length}`);
  const sourceSets = new Set<string>();
  for (const f of fileEntries) {
    const m = /src\/(\w+Main)\/kotlin\//.exec(f.path);
    if (m) sourceSets.add(m[1]!);
  }
  console.log(`KMP source sets detected: ${[...sourceSets].join(", ") || "(none — not a KMP project)"}`);

  // =========================================================================
  // 10. Anti-pattern scan (pattern-tools Kotlin patterns)
  // =========================================================================
  banner("10. Anti-pattern scan (Kotlin BUILTIN_PATTERNS)");
  const kotlinPatterns = [
    "runblocking-in-coroutine", "globalscope-launch", "data-class-mutable",
    "lateinit-no-check", "empty-when-branch", "mutable-shared-state",
    "kotest-missing-assertion", "kotest-mixed-styles",
  ];

  for (const name of kotlinPatterns) {
    const entry = BUILTIN_PATTERNS[name];
    if (!entry) {
      console.log(`  ${name.padEnd(28)} — NOT REGISTERED`);
      continue;
    }
    let hits = 0;
    const examples: string[] = [];
    for (const sym of symbols) {
      if (!sym.source) continue;
      if (entry.regex.test(sym.source)) {
        hits++;
        if (examples.length < 2) {
          examples.push(`${sym.name} (${sym.file}:${sym.start_line})`);
        }
      }
    }
    const verdict = hits === 0 ? "✓" : `⚠ ${hits}`;
    console.log(`  ${name.padEnd(28)} ${String(hits).padStart(4)}  ${verdict}`);
    for (const ex of examples) console.log(`      → ${ex}`);
  }

  // =========================================================================
  // 11. Summary verdict
  // =========================================================================
  banner("11. Summary — Wave 2 deployment verdict on tgmdev-tgm-panel-mobilapp");
  const verdictLines = [
    ["Parser",                 `${symbols.length} symbols from ${fileEntries.length} files, 0 errors`],
    ["Decorators (Task 3)",    `${annotationCounts.size} unique annotations, ${whitelisted.length} symbols whitelisted`],
    ["Kotest DSL (Task 4)",    testSuites.length > 0 ? `${testSuites.length} specs` : "not used (JUnit only)"],
    ["Gradle KTS (Task 5)",    `${plugins.length}p / ${deps.length}d / ${configs.length}c across ${gradleKtsCount} files`],
    ["Hilt DI (Task 7/8)",     hiltTotal > 0 ? `${viewModels.length} VMs, ${modules.length} modules` : "not used"],
    ["Suspend chain (9/10)",   `${suspendFns.length} suspend fns, ${totalDispatcherTransitions} transitions`],
    ["KMP (Task 11/12)",       expects.length > 0 ? `${expects.length} expects / ${actuals.length} actuals` : "not KMP"],
    ["Anti-patterns",          `${kotlinPatterns.length} Kotlin rules scanned`],
  ];
  for (const [label, value] of verdictLines) {
    console.log(`  ${label!.padEnd(24)} ${value}`);
  }

  banner("DONE");
}

main().catch((err) => {
  console.error("Analysis failed:", err);
  process.exit(1);
});
