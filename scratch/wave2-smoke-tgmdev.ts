/**
 * Wave 2 smoke test on tgmdev-tgm-panel-mobilapp.
 *
 * Walks the real Android Kotlin project via the Wave 2 extractors, builds
 * an in-memory index, then inlines the tool logic (avoiding vitest.vi which
 * isn't available outside a test runner). Reports aggregate stats for
 * every Wave 2 deliverable.
 */
import { readFile } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { initParser, getParser, getLanguageForPath } from "../src/parser/parser-manager.js";
import { extractKotlinSymbols } from "../src/parser/extractors/kotlin.js";
import { extractGradleKtsSymbols } from "../src/parser/extractors/gradle-kts.js";
import { walkDirectory } from "../src/utils/walk.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../src/types.js";
import { detectFrameworks, isFrameworkEntryPoint } from "../src/utils/framework-detect.js";

const REPO_ROOT = "/Users/greglas/DEV/tgmdev-tgm-panel-mobilapp";

function banner(title: string) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(` ${title}`);
  console.log("═".repeat(70));
}

async function main() {
  banner("Wave 2 smoke test — tgmdev-tgm-panel-mobilapp");
  console.log(`Repo: ${REPO_ROOT}`);

  await initParser();
  const parser = await getParser("kotlin");
  if (!parser) throw new Error("kotlin parser unavailable");

  // 1. Walk + parse.
  const allFiles = await walkDirectory(REPO_ROOT, {
    fileFilter: (ext) => ext === ".kt" || ext === ".kts",
  });
  const paths: string[] = allFiles.filter((p) => {
    const ext = extname(p);
    return ext === ".kt" || ext === ".kts";
  });
  console.log(`\nFound ${paths.length} .kt/.kts files`);

  const symbols: CodeSymbol[] = [];
  const fileEntries: FileEntry[] = [];
  let gradleKtsCount = 0;
  let kotestSpecCount = 0;
  let kmpModifierCount = 0;
  let annotatedCount = 0;
  let parseErrors = 0;

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
    for (const sym of extracted) {
      if (sym.kind === "test_suite") kotestSpecCount++;
      if (sym.meta?.["kmp_modifier"]) kmpModifierCount++;
      if (sym.decorators && sym.decorators.length > 0) annotatedCount++;
    }

    symbols.push(...extracted);
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

  console.log(`\nParsed: ${symbols.length} symbols, ${fileEntries.length} files (${parseErrors} parse errors)`);
  console.log(`  Gradle KTS files:        ${gradleKtsCount}`);
  console.log(`  Kotest test suites:      ${kotestSpecCount}`);
  console.log(`  KMP expect/actual:       ${kmpModifierCount}`);
  console.log(`  Symbols with decorators: ${annotatedCount}`);

  // 2. Framework detection + dead code whitelist spot-check.
  banner("Framework detection (Task 3: dead-code whitelist)");
  const frameworks = detectFrameworks(index);
  console.log(`Detected frameworks: ${[...frameworks].join(", ")}`);
  console.log(`kotlin-android present: ${frameworks.has("kotlin-android")}`);

  const kotlinSymbols = symbols.filter(
    (s) => s.file.endsWith(".kt") && (s.kind === "class" || s.kind === "function" || s.kind === "method"),
  );
  const whitelisted = kotlinSymbols.filter((s) => isFrameworkEntryPoint(s, frameworks));
  const pct = kotlinSymbols.length > 0
    ? ((whitelisted.length / kotlinSymbols.length) * 100).toFixed(1)
    : "0";
  console.log(`Whitelisted via framework annotations: ${whitelisted.length} / ${kotlinSymbols.length} (${pct}%)`);

  // Top annotations by count.
  const annotationCounts = new Map<string, number>();
  for (const sym of symbols) {
    for (const dec of sym.decorators ?? []) {
      annotationCounts.set(dec, (annotationCounts.get(dec) ?? 0) + 1);
    }
  }
  const topAnnotations = [...annotationCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  console.log("\nTop 10 annotations:");
  for (const [name, count] of topAnnotations) {
    console.log(`  @${name}: ${count}`);
  }

  // 3. Hilt DI graph (inlined).
  banner("Hilt DI graph (Task 7/8)");
  const hiltEntryDecorators = new Set(["HiltViewModel", "HiltAndroidApp", "AndroidEntryPoint"]);
  const viewModels = symbols.filter(
    (s) => s.kind === "class" && s.decorators?.some((d) => d === "HiltViewModel"),
  );
  const androidEntryPoints = symbols.filter(
    (s) => s.kind === "class" && s.decorators?.some((d) => d === "AndroidEntryPoint"),
  );
  const modules = symbols.filter(
    (s) => s.kind === "class" && s.decorators?.some((d) => d === "Module"),
  );
  console.log(`@HiltViewModel classes:    ${viewModels.length}`);
  console.log(`@AndroidEntryPoint:        ${androidEntryPoints.length}`);
  console.log(`@Module classes:           ${modules.length}`);

  // Scan for @Provides / @Binds methods.
  const providers = symbols.filter(
    (s) => (s.kind === "method" || s.kind === "function") &&
           s.decorators?.some((d) => d === "Provides" || d === "Binds"),
  );
  console.log(`@Provides/@Binds methods:  ${providers.length}`);

  if (viewModels.length > 0) {
    console.log("\nSample @HiltViewModel classes (first 5):");
    for (const vm of viewModels.slice(0, 5)) {
      const match = /@Inject\s+constructor\s*\(([^)]*)\)/s.exec(vm.source ?? "");
      const paramCount = match?.[1]?.split(",").filter((p) => p.trim()).length ?? 0;
      console.log(`  ${vm.name}  (${paramCount} injected deps)  ${vm.file}`);
    }
  }

  // 4. Coroutine anti-patterns (aggregate suspend-function scan).
  banner("Coroutine anti-patterns (Task 9/10)");
  const allSuspends = symbols.filter(
    (s) => (s.kind === "function" || s.kind === "method") &&
           (s.signature?.startsWith("suspend") || /\bsuspend\s+fun\b/.test(s.source?.slice(0, 120) ?? "")),
  );
  let totalRunBlocking = 0;
  let totalThreadSleep = 0;
  let totalNonCancellable = 0;
  let totalDispatcherTransitions = 0;
  const dispatcherBuckets = new Map<string, number>();
  const runBlockingExamples: string[] = [];
  const threadSleepExamples: string[] = [];
  // Same classifier as src/tools/kotlin-tools.ts:classifyDispatcherExpression
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
  for (const fn of allSuspends) {
    const src = fn.source ?? "";
    if (/\brunBlocking\s*[\{(]/.test(src)) {
      totalRunBlocking++;
      if (runBlockingExamples.length < 3) runBlockingExamples.push(`${fn.name} (${fn.file}:${fn.start_line})`);
    }
    if (/\bThread\.sleep\s*\(/.test(src)) {
      totalThreadSleep++;
      if (threadSleepExamples.length < 3) threadSleepExamples.push(`${fn.name} (${fn.file}:${fn.start_line})`);
    }
    const whileMatch = /\bwhile\s*\(\s*true\s*\)\s*\{([\s\S]*?)\}/.exec(src);
    if (whileMatch && !/(ensureActive|isActive)/.test(whileMatch[1] ?? "")) totalNonCancellable++;
    const dispatcherRe = /withContext\s*\(\s*([A-Za-z_][\w.]*)\s*[,)]/g;
    let m: RegExpExecArray | null;
    while ((m = dispatcherRe.exec(src)) !== null) {
      const kind = classifyDispatcher(m[1]!);
      if (!kind) continue;
      totalDispatcherTransitions++;
      dispatcherBuckets.set(kind, (dispatcherBuckets.get(kind) ?? 0) + 1);
    }
  }
  console.log(`Total suspend functions:       ${allSuspends.length}`);
  console.log(`Dispatcher transitions:        ${totalDispatcherTransitions}`);
  if (dispatcherBuckets.size > 0) {
    const bucketsStr = [...dispatcherBuckets.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(`  Breakdown: ${bucketsStr}`);
  }
  console.log(`runBlocking in suspend:        ${totalRunBlocking} ${totalRunBlocking > 0 ? "⚠ CRITICAL" : "✓"}`);
  if (runBlockingExamples.length > 0) {
    for (const ex of runBlockingExamples) console.log(`    → ${ex}`);
  }
  console.log(`Thread.sleep in suspend:       ${totalThreadSleep} ${totalThreadSleep > 0 ? "⚠ CRITICAL" : "✓"}`);
  if (threadSleepExamples.length > 0) {
    for (const ex of threadSleepExamples) console.log(`    → ${ex}`);
  }
  console.log(`non-cancellable while(true):   ${totalNonCancellable} ${totalNonCancellable > 0 ? "⚠" : "✓"}`);

  // 5. KMP expect/actual.
  banner("KMP expect/actual (Task 11/12)");
  const kmpSymbols = symbols.filter((s) => s.meta?.["kmp_modifier"]);
  const expects = kmpSymbols.filter((s) => s.meta!["kmp_modifier"] === "expect");
  const actuals = kmpSymbols.filter((s) => s.meta!["kmp_modifier"] === "actual");
  console.log(`Total expect declarations: ${expects.length}`);
  console.log(`Total actual declarations: ${actuals.length}`);
  const sourceSets = new Set<string>();
  for (const f of fileEntries) {
    const match = /src\/(\w+Main)\/kotlin\//.exec(f.path);
    if (match) sourceSets.add(match[1]!);
  }
  console.log(`KMP source sets detected:  ${[...sourceSets].join(", ") || "(none — not a KMP project)"}`);

  // 6. Kotest summary.
  banner("Kotest DSL detection (Task 4)");
  const testSuites = symbols.filter((s) => s.kind === "test_suite");
  const testCases = symbols.filter((s) => s.kind === "test_case");
  console.log(`Kotest test_suite classes: ${testSuites.length}`);
  console.log(`test_case symbols:         ${testCases.length}`);
  if (testSuites.length > 0) {
    console.log("\nFirst 5 Kotest specs:");
    for (const suite of testSuites.slice(0, 5)) {
      const childCount = testCases.filter((t) => t.parent === suite.id).length;
      console.log(`  ${suite.name}  (${childCount} test cases)  ${suite.file}`);
    }
  }

  banner("DONE");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
