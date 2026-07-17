import type { BuiltinPatternDefinition } from "../types.js";

export const KOTLIN_PATTERNS: Record<string, BuiltinPatternDefinition> = {
  // Kotlin anti-patterns
  "runblocking-in-coroutine": {
    regex: /suspend\s+fun[\s\S]{0,500}runBlocking\s*[\({]/,
    description: "runBlocking inside suspend function — deadlock risk (Kotlin coroutines)",
  },
  "globalscope-launch": {
    regex: /GlobalScope\.(launch|async)\s*[\({]/,
    description: "GlobalScope.launch/async — lifecycle leak, use structured concurrency (Kotlin)",
  },
  "data-class-mutable": {
    regex: /data\s+class\s+\w+\([^)]*\bvar\s+/,
    description: "data class with var property — breaks hashCode/equals contract (Kotlin)",
  },
  "lateinit-no-check": {
    regex: /lateinit\s+var\s+(\w+)/,
    description: "lateinit var without isInitialized check — UninitializedPropertyAccessException risk (Kotlin)",
  },
  "empty-when-branch": {
    regex: /when\s*\([^)]*\)\s*\{[\s\S]*?->\s*\{\s*\}/,
    description: "Empty when branch — swallowed case (Kotlin)",
  },
  "mutable-shared-state": {
    regex: /(?:companion\s+object|object\s+\w+)\s*\{[\s\S]*?\bvar\s+/,
    description: "Mutable var inside object/companion — thread-unsafe shared state (Kotlin)",
  },
  // Kotest anti-patterns — require include_tests=true to surface
  "kotest-missing-assertion": {
    regex: /\btest\s*\(\s*"[^"]*"\s*\)\s*\{(?:(?!\bshould(?:Be|NotBe|Throw|Contain|Match|HaveSize)\b|\bshould\s*\{|\bshouldBe\b|\bassertSoftly\b|\bassertThat\b|\bassertTrue\b|\bassertFalse\b|\bassertEquals\b|\bexpect\s*\(|\bverify\s*\()[\s\S])*?\}/,
    description: "Kotest test block without any shouldBe/shouldThrow/assertSoftly/assertEquals — missing assertion",
  },
  "kotest-mixed-styles": {
    regex: /(?:\bFunSpec\s*\([\s\S]*?(?:\bDescribeSpec|\bStringSpec|\bBehaviorSpec|\bShouldSpec|\bWordSpec|\bFeatureSpec|\bExpectSpec)\s*\()|(?:(?:\bDescribeSpec|\bStringSpec|\bBehaviorSpec|\bShouldSpec|\bWordSpec|\bFeatureSpec|\bExpectSpec)\s*\([\s\S]*?\bFunSpec\s*\()/,
    description: "Multiple Kotest spec styles (e.g. FunSpec + DescribeSpec) in same file — inconsistent test layout",
  },
  // Jetpack Compose anti-patterns
  "compose-missing-remember": {
    regex: /(?<!\bremember\s*\{[^}]{0,60})\b(?:mutableStateOf|mutableStateListOf|mutableIntStateOf|derivedStateOf)\s*(?:<[^>]*>)?\s*\(/,
    description: "mutableStateOf/derivedStateOf without remember — state resets every recomposition (Compose)",
  },
  "compose-unstable-lambda": {
    regex: /@Composable[\s\S]{0,2000}?\bon[A-Z]\w*\s*:\s*\([^)]*\)\s*->\s*Unit/,
    description: "Event callback param with function type — unstable, causes child recomposition every frame unless caller uses remember (Compose)",
  },
  "compose-side-effect-in-composition": {
    regex: /@Composable[\s\S]{0,1000}?(?:\bcoroutineScope\s*\{|\bviewModelScope\.launch|\bGlobalScope\.launch)/,
    description: "Coroutine launch in @Composable body — use LaunchedEffect/rememberCoroutineScope instead (Compose)",
  },
};
