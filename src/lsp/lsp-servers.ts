import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

export interface LspServerConfig {
  command: string;
  args: string[];
  languages: string[];
  initOptions?: Record<string, unknown>;
}

export const LSP_SERVERS: Record<string, LspServerConfig> = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    languages: ["typescript", "javascript", "tsx", "jsx"],
  },
  python: {
    command: "pylsp",
    args: [],
    languages: ["python"],
  },
  go: {
    command: "gopls",
    args: ["serve"],
    languages: ["go"],
  },
  rust: {
    command: "rust-analyzer",
    args: [],
    languages: ["rust"],
  },
  ruby: {
    command: "solargraph",
    args: ["stdio"],
    languages: ["ruby"],
  },
  php: {
    command: "intelephense",
    args: ["--stdio"],
    languages: ["php"],
  },
  kotlin: {
    command: "kotlin-language-server",
    args: [],
    languages: ["kotlin"],
  },
};

export function getLspConfigForLanguage(language: string): { name: string; config: LspServerConfig } | null {
  for (const [name, config] of Object.entries(LSP_SERVERS)) {
    if (config.languages.includes(language)) {
      return { name, config };
    }
  }
  return null;
}

// WHERE typescript-language-server FINDS TYPESCRIPT, when the workspace has none.
//
// It resolves `typescript` from the workspace root and gives up otherwise ("Could not find a valid
// TypeScript installation … Exiting"). Measured 2026-09-30: 121 such failures in the daemon log, all
// in tgm-survey-platform worktrees — agents run tests on the remote farm (`rt`), so worktrees never
// get a local node_modules, and neither did the main checkout. Every LSP-backed tool (references,
// definition, rename, call hierarchy) silently fell back or failed there.
//
// Order: the workspace or any ancestor (monorepo root) · the main checkout of a linked worktree (same
// repo, so the same TypeScript major) · CODESIFT_TSSERVER_PATH · CodeSift's own dependency tree ·
// the global npm root. The first hit is passed as `initializationOptions.tsserver.path`; null means
// "let the server look for itself", which is exactly the old behaviour.
const TSSERVER_REL = join("node_modules", "typescript", "lib", "tsserver.js");
let globalTsserver: string | null | undefined;

export function resolveTsserverPath(
  rootPath: string,
  deps: {
    exists?: (p: string) => boolean;
    gitCommonDir?: (cwd: string) => string | null;
    env?: NodeJS.ProcessEnv;
    ownResolve?: () => string | null;
    globalRoot?: () => string | null;
  } = {},
): string | null {
  const exists = deps.exists ?? existsSync;
  const env = deps.env ?? process.env;

  for (let dir = resolve(rootPath); ; dir = dirname(dir)) {
    const p = join(dir, TSSERVER_REL);
    if (exists(p)) return p;
    if (dirname(dir) === dir) break;
  }

  const common = (deps.gitCommonDir ?? defaultGitCommonDir)(rootPath);
  if (common) {
    const p = join(dirname(common), TSSERVER_REL);
    if (exists(p)) return p;
  }

  const override = env["CODESIFT_TSSERVER_PATH"];
  if (override && exists(override)) return override;

  const own = (deps.ownResolve ?? defaultOwnResolve)();
  if (own && exists(own)) return own;

  if (deps.globalRoot) {
    const root = deps.globalRoot();
    const p = root ? join(root, "typescript", "lib", "tsserver.js") : null;
    return p && exists(p) ? p : null;
  }
  if (globalTsserver === undefined) {
    const root = defaultGlobalRoot();
    const p = root ? join(root, "typescript", "lib", "tsserver.js") : null;
    globalTsserver = p && existsSync(p) ? p : null;
  }
  return globalTsserver;
}

function defaultGitCommonDir(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 2_000, encoding: "utf8",
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function defaultOwnResolve(): string | null {
  try {
    return createRequire(import.meta.url).resolve("typescript/lib/tsserver.js");
  } catch {
    return null;
  }
}

function defaultGlobalRoot(): string | null {
  try {
    return execFileSync("npm", ["root", "-g"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const availabilityCache = new Map<string, boolean>();

export function isLspAvailable(config: LspServerConfig): boolean {
  const cached = availabilityCache.get(config.command);
  if (cached !== undefined) return cached;

  try {
    // A timeout, because a hung `which` had nothing to stop it: this runs synchronously in the
    // shared daemon, so one wedged lookup would block every client indefinitely. 2 s is far more
    // than a PATH search needs and far less than anyone would wait.
    execFileSync("which", [config.command], { stdio: "ignore", timeout: 2_000 });
    availabilityCache.set(config.command, true);
    return true;
  } catch {
    availabilityCache.set(config.command, false);
    return false;
  }
}
