/**
 * Loader for the Rust core (ADR-006).
 *
 * The native module is OPTIONAL by design: every component it accelerates keeps its TypeScript
 * implementation, and an install without a prebuilt binary for its platform must behave exactly
 * as CodeSift did before the core existed. So in the default `auto` mode a missing or unusable
 * binary is a fact to report once, never an error.
 *
 * Switches, modelled on `CODESIFT_INDEX_BACKEND`:
 *   CODESIFT_NATIVE              auto (default) | 0 | 1
 *   CODESIFT_NATIVE_<COMPONENT>  same values, overrides the global one for that component
 *                                (STORE, BM25, PARSER — added with the stage that uses each)
 * `1` means REQUIRED: the parity suites run with it, and a binary that fails to load there must
 * fail the run rather than quietly test the TypeScript path twice.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Must equal `codesift_core::ABI_VERSION`. See the comment there for why a mismatch refuses. */
export const NATIVE_ABI = 7;

/** `SymbolQuery` from storage/sqlite/queries.ts, as the binding receives it. */
export interface NativeSymbolQuery {
  withSource: boolean;
  file?: string;
  name?: string;
  namePrefix?: string;
  kind?: string;
  parent?: string;
  ids?: readonly string[];
  limit?: number;
}

export interface NativeIndexMeta {
  repo: string;
  root: string;
  updatedAt?: string | null;
  symbolCount: number;
  fileCount: number;
}

/** One page of a paged read (`SymbolSnapshot.page`). `lastRowid` is null on an empty page. */
export interface NativePage {
  json: string;
  count: number;
  lastRowid?: number | null;
}

/** A read transaction held across pages; `close()` ends it. */
export interface NativeSymbolSnapshot {
  readonly repo: string | null;
  page(query: NativeSymbolQuery, idChunk: readonly string[] | undefined, afterRowid: number, rows: number): Promise<NativePage>;
  close(): void;
}

/** The `CodeSymbol` fields the native BM25 reads; a whole `CodeSymbol` satisfies it. */
export interface NativeBm25Symbol {
  id: string;
  file: string;
  name: string;
  signature?: string;
  docstring?: string;
  source?: string;
}

export interface NativeBm25Hit {
  id: string;
  score: number;
  matches: string[];
}

/** A BM25 index living in Rust memory (ADR-006 stage 2). */
export interface NativeBm25Handle {
  ingest(symbols: readonly NativeBm25Symbol[]): void;
  finish(): void;
  /** `weights` in field order: name, signature, docstring, body, comments. */
  search(query: string, topK: number, weights: number[]): NativeBm25Hit[];
  updateFile(file: string, symbols: readonly NativeBm25Symbol[]): void;
  /** `[file, score]` for every file with a non-zero import centrality. */
  centrality(): Array<[string, number]>;
  readonly docCount: number;
  footprintBytes(): number;
}

/** One file's extraction (ADR-006 stage 3). */
export interface NativeExtracted {
  /** The symbols as a JSON array, in `makeSymbol` key order. */
  json: string;
  hasError: boolean;
  timedOut: boolean;
  /** Warnings the TypeScript extractor would have printed (e.g. Python's MAX_WALK_DEPTH). */
  warnings: string[];
}

export interface NativeCore {
  version(): string;
  abiVersion(): number;
  /** Matching symbols as JSON arrays to concatenate in order — chunked so no single string nears
   *  V8's ~512 MB limit — built off the main thread (ADR-006 stage 1). */
  findSymbols(dbPath: string, query: NativeSymbolQuery): Promise<string[]>;
  indexMeta(dbPath: string): Promise<NativeIndexMeta | null>;
  openSnapshot(dbPath: string): Promise<NativeSymbolSnapshot>;
  NativeBm25: new () => NativeBm25Handle;
  /** Parse and extract one file off the main thread (TypeScript, TSX, JavaScript, Python, Go, Rust). */
  extractSymbols(source: string, file: string, repo: string, language: string, timeoutMs: number): Promise<NativeExtracted>;
}

export type NativeMode = "auto" | "off" | "required";

export interface NativeStatus {
  mode: NativeMode;
  loaded: boolean;
  /** Core crate version, when loaded. */
  version?: string;
  /** Where the binary came from: a platform package name or a file path. */
  source?: string;
  /** Why it is not loaded. Absent when loaded or switched off. */
  reason?: string;
}

export class NativeCoreUnavailableError extends Error {
  constructor(reason: string) {
    super(`CODESIFT_NATIVE=1 but the native core is unavailable: ${reason}`);
    this.name = "NativeCoreUnavailableError";
  }
}

function parseMode(raw: string | undefined): NativeMode | undefined {
  if (raw === undefined || raw === "") return undefined;
  switch (raw.trim().toLowerCase()) {
    case "auto":
      return "auto";
    case "0":
    case "false":
    case "off":
      return "off";
    case "1":
    case "true":
    case "on":
      return "required";
    default:
      return undefined;
  }
}

/**
 * The mode for one component. An unrecognised value falls back to `auto` rather than `required`:
 * a typo must not turn a working install into a refusing one.
 */
export function nativeMode(component?: string, env: NodeJS.ProcessEnv = process.env): NativeMode {
  if (component) {
    const own = parseMode(env[`CODESIFT_NATIVE_${component.toUpperCase()}`]);
    if (own) return own;
  }
  return parseMode(env["CODESIFT_NATIVE"]) ?? "auto";
}

/**
 * The napi-rs platform tag, which names both the platform package (`@codesift/core-<tag>`) and the
 * locally built file (`native/codesift-core.<tag>.node`). `scripts/build-native.mjs` carries its own
 * copy because it runs before `dist/` exists; `tests/native/loader.test.ts` holds the two equal.
 */
export function platformTag(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  isMusl: () => boolean = detectMusl,
): string | null {
  switch (platform) {
    case "darwin":
      return arch === "arm64" || arch === "x64" ? `darwin-${arch}` : null;
    case "win32":
      return arch === "x64" || arch === "arm64" ? `win32-${arch}-msvc` : null;
    case "linux":
      if (arch !== "x64" && arch !== "arm64") return null;
      return `linux-${arch}-${isMusl() ? "musl" : "gnu"}`;
    default:
      return null;
  }
}

function detectMusl(): boolean {
  // `ldd` is a script on glibc and a symlink to the musl loader on Alpine; reading it is how
  // napi-rs's own loader decides, and it is cheaper than `process.report.getReport()`, which
  // enumerates network interfaces and has been measured slow on hosts with many of them.
  try {
    return readFileSync("/usr/bin/ldd", "utf8").includes("musl");
  } catch {
    return false;
  }
}

/** Repo / package root: this file is `src/native/index.ts` or `dist/native/index.js`. */
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export interface NativeCandidate {
  source: string;
  load: () => unknown;
}

export function defaultCandidates(tag: string, root: string = packageRoot()): NativeCandidate[] {
  const require = createRequire(import.meta.url);
  const pkg = `@codesift/core-${tag}`;
  // The local build wins over the platform package: a developer who just ran `build:native` is
  // testing THAT binary, and a published one shadowing it would make the run test something else.
  const local = join(root, "native", `codesift-core.${tag}.node`);
  return [
    { source: local, load: () => (existsSync(local) ? require(local) : undefined) },
    { source: pkg, load: () => require(pkg) },
  ];
}

function isNativeCore(mod: unknown): mod is NativeCore {
  if (typeof mod !== "object" || mod === null) return false;
  const m = mod as Record<string, unknown>;
  return typeof m["version"] === "function" && typeof m["abiVersion"] === "function";
}

/**
 * Try each candidate in order; the first that loads AND speaks our ABI wins. Pure apart from the
 * candidates' own `load`, so tests drive it without a binary on disk.
 */
export function loadFromCandidates(
  candidates: NativeCandidate[],
): { core: NativeCore; source: string } | { core: null; reason: string } {
  const failures: string[] = [];
  for (const c of candidates) {
    let mod: unknown;
    try {
      mod = c.load();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Absence is not a failure worth naming per candidate; a broken binary is.
      if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
        failures.push(`${c.source}: ${(err as Error).message.split("\n")[0]}`);
      }
      continue;
    }
    if (mod === undefined) continue;
    if (!isNativeCore(mod)) {
      failures.push(`${c.source}: not a codesift core module`);
      continue;
    }
    const abi = mod.abiVersion();
    if (abi !== NATIVE_ABI) {
      failures.push(`${c.source}: ABI ${abi}, this build needs ${NATIVE_ABI} — rebuild with \`npm run build:native\``);
      continue;
    }
    return { core: mod, source: c.source };
  }
  return { core: null, reason: failures.length > 0 ? failures.join("; ") : "no binary for this platform" };
}

type Attempt = { core: NativeCore; source: string } | { core: null; reason: string };

let attempt: Attempt | undefined;
let warned = false;

/** One load per process, whatever the mode: the modes decide what to DO with the result. */
function attemptLoad(): Attempt {
  if (attempt) return attempt;
  const tag = platformTag();
  attempt = tag
    ? loadFromCandidates(defaultCandidates(tag))
    : { core: null, reason: `unsupported platform ${process.platform}-${process.arch}` };
  return attempt;
}

/**
 * The core, or `null` when it is off or unavailable in `auto` mode.
 * @throws NativeCoreUnavailableError when the mode is `required` and it did not load.
 */
export function getNativeCore(component?: string): NativeCore | null {
  const mode = nativeMode(component);
  if (mode === "off") return null;
  const a = attemptLoad();
  if (a.core) return a.core;
  if (mode === "required") throw new NativeCoreUnavailableError(a.reason);
  if (!warned) {
    warned = true;
    // Once per process: today most installs have no binary, and that is the expected state, not news.
    process.stderr.write(`[codesift] native core not loaded (${a.reason}) — using the TypeScript implementation\n`);
  }
  return null;
}

/** For `/health`. Loads the core if nothing has yet, so the answer is about this process. */
export function nativeStatus(): NativeStatus {
  const mode = nativeMode();
  if (mode === "off") return { mode, loaded: false };
  const a = attemptLoad();
  return a.core
    ? { mode, loaded: true, version: a.core.version(), source: a.source }
    : { mode, loaded: false, reason: a.reason };
}

export function resetNativeForTesting(): void {
  attempt = undefined;
  warned = false;
}
