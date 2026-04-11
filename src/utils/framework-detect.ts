import type { CodeIndex, CodeSymbol } from "../types.js";
import type { HonoAppModel } from "../parser/extractors/hono-model.js";

export type Framework = "react" | "nestjs" | "nextjs" | "express" | "astro" | "hono" | "test" | "kotlin-android";

/**
 * Kotlin/Android annotations that mark a symbol as referenced by the runtime
 * rather than by static imports. `find_dead_code` must treat these as live
 * because Hilt (reflection), Compose (tooling), Room (KSP), kotlinx.serialization
 * (JSON), and JUnit/Kotest (runner) all instantiate or invoke symbols outside
 * the normal call graph.
 */
export const KOTLIN_FRAMEWORK_ANNOTATIONS: ReadonlySet<string> = new Set([
  // Hilt / Dagger DI
  "HiltViewModel", "HiltAndroidApp", "AndroidEntryPoint",
  "Inject", "Module", "Provides", "Binds", "InstallIn", "Singleton",
  // Jetpack Compose + Compose tooling
  "Composable", "Preview", "PreviewParameter",
  // kotlinx.serialization
  "Serializable", "SerialName", "Transient",
  // Room persistence
  "Entity", "Dao", "Database", "Query", "Insert", "Update", "Delete",
  "TypeConverter", "TypeConverters", "PrimaryKey", "Embedded", "Relation",
  // Android framework entry points
  "Keep", "JvmStatic", "JvmOverloads", "JvmName", "JvmField",
  // Test runners (JUnit4/5 + Kotest)
  "Test", "BeforeEach", "AfterEach", "BeforeAll", "AfterAll",
  "Before", "After", "BeforeClass", "AfterClass",
  "ParameterizedTest", "RepeatedTest",
  // Kotlin Multiplatform
  "JsExport", "ObjCName", "Throws",
]);

const NEXT_ROUTE_FILE = /(^|\/)app\/.*\/route\.[jt]sx?$/;
const NEXT_APP_FILE = /(^|\/)app\/.+\.[jt]sx?$/;
const NEXT_PAGES_FILE = /(^|\/)pages\/.+\.[jt]sx?$/;
const NEXT_MIDDLEWARE_FILE = /(^|\/)middleware\.[jt]sx?$/;

const NEXT_ROUTE_METHODS = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/;
const NEXT_PAGES_DATA_FUNCTIONS = /^(getServerSideProps|getStaticProps|getStaticPaths)$/;
const NEXT_APP_METADATA_FUNCTIONS = /^(generateMetadata|generateStaticParams)$/;
/** Next.js config exports that are framework entry points (not dead code) */
const NEXT_CONFIG_EXPORTS = /^(metadata|viewport|dynamic|revalidate|runtime|preferredRegion|maxDuration|fetchCache|dynamicParams)$/;

/** NestJS lifecycle hooks + decorator-based entry points */
const NESTJS_LIFECYCLE = /^(onModuleInit|onModuleDestroy|onApplicationBootstrap|onApplicationShutdown|beforeApplicationShutdown|handleCron|handleInterval|handleTimeout|handleEvent)$/;
const NESTJS_ENTRY_FILE = /\.(controller|resolver|gateway|guard|interceptor|pipe|filter)\.[jt]sx?$/;
const NESTJS_MAIN_FILE = /(^|\/)main\.[jt]sx?$/;

/** Astro file-based routing — pages/ directory with .astro, .ts, or .js files */
const ASTRO_PAGES_FILE = /(^|\/)src\/pages\/.+\.(astro|[jt]sx?)$/;
/** Astro special exports that the framework consumes implicitly */
const ASTRO_ENTRY_SYMBOLS = /^(getStaticPaths|prerender|GET|POST|PUT|DELETE|PATCH)$/;

/** React/Next.js app router file conventions — these are route entry points */
const REACT_ROUTE_FILE = /(^|\/)(pages|app)\/.*\.(tsx|jsx)$/;
/** Special Next.js/Remix file names that are always entry points regardless of export name */
const REACT_SPECIAL_FILE = /(^|\/)(page|layout|loading|error|not-found|global-error|default|template|head)\.(tsx|jsx)$/;
/** Remix convention: routes/ directory with file-based routing */
const REMIX_ROUTE_FILE = /(^|\/)routes\/.*\.(tsx|jsx)$/;

/** Exported for testing — matches next.config.{js,mjs,cjs,ts} at root or src/ */
export const NEXT_CONFIG_FILE = /^(src\/)?next\.config\.[mc]?[jt]s$/;
/** Exported for testing — App Router convention files */
export const NEXT_APP_CONVENTION_FILE = /(^|\/)app\/(.*\/)?(page|layout|loading|error|not-found|global-error|default|template|route)\.[jt]sx?$/;

export function detectFrameworks(index: CodeIndex): Set<Framework> {
  const frameworks = new Set<Framework>();
  // Sample first 200 symbols' source for framework indicators
  const sources = index.symbols.slice(0, 200).map((s) => s.source ?? "").join("\n");

  if (sources.includes("@nestjs/") || sources.includes("NestFactory")) frameworks.add("nestjs");
  if (sources.includes("from 'react'") || sources.includes('from "react"') || sources.includes("useState")) frameworks.add("react");
  if (sources.includes("express()") || sources.includes("Router()")) frameworks.add("express");
  // Hono detection: check symbol sources for new Hono() / new OpenAPIHono() instantiation,
  // or import statements (captured in some extractor flows), or hono/factory createApp
  if (
    /new\s+(?:Hono|OpenAPIHono)\s*(?:<[^>]*>)?\s*\(/.test(sources) ||
    sources.includes("from 'hono'") ||
    sources.includes('from "hono"') ||
    sources.includes("from '@hono/zod-openapi'") ||
    sources.includes('from "@hono/zod-openapi"') ||
    sources.includes("factory.createApp")
  ) {
    frameworks.add("hono");
  }
  if (sources.includes("from 'astro'") || sources.includes('from "astro"') || sources.includes("from 'astro:") || sources.includes('from "astro:') || index.files.some((f) => f.path.endsWith(".astro"))) frameworks.add("astro");

  // Kotlin/Android detection: any .kt file is a signal. The annotation
  // whitelist kicks in across all Kotlin symbols regardless of whether Hilt
  // is actually in use — the cost of a false negative (flagging @HiltViewModel
  // as dead code) is much higher than the cost of a false positive (allowing
  // a few annotated symbols through when the project isn't Android).
  if (index.files.some((f) => f.path.endsWith(".kt") || f.path.endsWith(".kts"))) {
    frameworks.add("kotlin-android");
  }

  // Next.js detection: broadened to cover config file, pages/ dir, and App Router conventions
  const hasNextConfig = index.files.some((f) => NEXT_CONFIG_FILE.test(f.path));
  const hasPagesDir = index.files.some((f) => NEXT_PAGES_FILE.test(f.path) && /\.[jt]sx?$/.test(f.path));
  const hasAppConvention = index.files.some((f) => NEXT_APP_CONVENTION_FILE.test(f.path));
  if (hasNextConfig || hasPagesDir || hasAppConvention) {
    frameworks.add("nextjs");
  }

  frameworks.add("test"); // always include test patterns

  return frameworks;
}

export function isFrameworkEntryPoint(
  symbol: Pick<CodeSymbol, "name" | "file"> & { source?: string; decorators?: string[] | undefined },
  frameworks: Set<Framework>,
  honoModel?: HonoAppModel | null,
): boolean {
  // Kotlin/Android: whitelisted annotations mark a symbol as runtime-referenced
  // (Hilt, Compose, Room, serialization, Android entry points, JUnit).
  if (frameworks.has("kotlin-android") && (symbol.file.endsWith(".kt") || symbol.file.endsWith(".kts"))) {
    const decorators = symbol.decorators;
    if (decorators && decorators.length > 0) {
      for (const decorator of decorators) {
        if (KOTLIN_FRAMEWORK_ANNOTATIONS.has(decorator)) return true;
      }
    }
    // Fallback for symbols where the extractor didn't surface decorators yet:
    // scan the first 400 chars of source for any whitelisted @Annotation.
    // Cheaper than re-parsing and keeps correctness as the extractor evolves.
    const head = symbol.source?.slice(0, 400);
    if (head) {
      for (const annotation of KOTLIN_FRAMEWORK_ANNOTATIONS) {
        // Word-boundary match against "@Annotation" to avoid false matches on
        // @HiltViewModelInternal or similar.
        const re = new RegExp(`@${annotation}\\b`);
        if (re.test(head)) return true;
      }
    }
  }

  if (frameworks.has("hono") && honoModel) {
    // Symbol is in a file that the HonoExtractor reached
    if (honoModel.files_used.includes(symbol.file)) {
      // Handler function referenced by a route
      if (honoModel.routes.some((r) => r.handler.name === symbol.name)) return true;
      // Middleware referenced in any chain
      if (honoModel.middleware_chains.some((mc) =>
        mc.entries.some((e) => e.name === symbol.name))) return true;
      // Sub-app variable mounted via app.route()
      if (honoModel.mounts.some((m) => m.child_var === symbol.name)) return true;
      // The root Hono app variable itself
      if (honoModel.app_variables[symbol.name]) return true;
    }
  }
  if (frameworks.has("nextjs")) {
    if (NEXT_ROUTE_FILE.test(symbol.file) && NEXT_ROUTE_METHODS.test(symbol.name)) return true;
    if (NEXT_MIDDLEWARE_FILE.test(symbol.file) && symbol.name === "middleware") return true;
    if (NEXT_PAGES_FILE.test(symbol.file) && NEXT_PAGES_DATA_FUNCTIONS.test(symbol.name)) return true;
    if (NEXT_APP_FILE.test(symbol.file) && NEXT_APP_METADATA_FUNCTIONS.test(symbol.name)) return true;
    if (NEXT_APP_FILE.test(symbol.file) && NEXT_CONFIG_EXPORTS.test(symbol.name)) return true;
  }

  if (frameworks.has("nestjs")) {
    if (NESTJS_LIFECYCLE.test(symbol.name)) return true;
    if (NESTJS_ENTRY_FILE.test(symbol.file)) return true;
    if (NESTJS_MAIN_FILE.test(symbol.file) && symbol.name === "bootstrap") return true;
  }

  if (frameworks.has("astro")) {
    if (ASTRO_PAGES_FILE.test(symbol.file)) return true;
    if (ASTRO_ENTRY_SYMBOLS.test(symbol.name)) return true;
  }

  // React route/layout components: any default export from a routed file
  // (pages/, app/, or routes/) is an entry point — the framework renders it
  // based on file path, not via explicit import. Without this, find_dead_code
  // flags them as unused.
  if (frameworks.has("react") || frameworks.has("nextjs")) {
    if (REACT_SPECIAL_FILE.test(symbol.file)) return true;
    if (REACT_ROUTE_FILE.test(symbol.file)) return true;
    if (REMIX_ROUTE_FILE.test(symbol.file)) return true;
  }

  // RSC boundary: "use client" / "use server" directive → framework entry point
  if (symbol.source && (frameworks.has("react") || frameworks.has("nextjs"))) {
    const head = symbol.source.slice(0, 200);
    if (/['"]use client['"]/.test(head) || /['"]use server['"]/.test(head)) return true;
  }

  return false;
}
