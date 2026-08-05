import { readFile } from "node:fs/promises";
import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { Registry, RepoMeta } from "../types.js";
import { atomicWriteFile } from "./_shared.js";

/**
 * Load the multi-repo registry from disk.
 * Returns an empty registry if the file doesn't exist or is invalid.
 */
export async function loadRegistry(registryPath: string): Promise<Registry> {
  try {
    const raw = await readFile(registryPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (isValidRegistry(parsed)) {
      return parsed;
    }

    return emptyRegistry();
  } catch {
    return emptyRegistry();
  }
}

/**
 * Save the registry atomically.
 * Writes to a temp file first, then renames to prevent partial reads.
 */
export async function saveRegistry(
  registryPath: string,
  registry: Registry,
): Promise<void> {
  const data = JSON.stringify(registry);
  await atomicWriteFile(registryPath, data);
}

/**
 * Serialises read-modify-write cycles per registry file.
 *
 * `registerRepo` / `updateRepoMeta` / `removeRepo` each load the whole registry,
 * mutate one entry and write it back. Nothing kept two of those from
 * interleaving, so the classic lost update applied: A reads, B reads, A writes,
 * B writes — and A's repo is silently gone from the registry. The caller sees a
 * successful index followed by "Repository ... not found", or `prune` reporting
 * zero repos.
 *
 * Concurrency here is not hypothetical even in a single process: watcher-driven
 * re-indexing, background embedding and auto-index all call these unawaited
 * while a foreground tool call is doing the same. `index-store.ts` already
 * serialises its own writes this way (`writeLocks`); the registry never did.
 */
const registryWriteLocks = new Map<string, Promise<unknown>>();

function withRegistryLock<T>(registryPath: string, work: () => Promise<T>): Promise<T> {
  const prev = registryWriteLocks.get(registryPath) ?? Promise.resolve();
  const next = prev.then(work, work);
  // Swallow on the chain only — the caller still sees its own rejection.
  registryWriteLocks.set(registryPath, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Register or update a repo in the registry.
 */
export async function registerRepo(
  registryPath: string,
  meta: RepoMeta,
): Promise<void> {
  return withRegistryLock(registryPath, async () => {
    const registry = await loadRegistry(registryPath);
    registry.repos[meta.name] = meta;
    registry.updated_at = Date.now();
    await saveRegistry(registryPath, registry);
  });
}

/**
 * Get a single repo's metadata by name.
 * Returns null if the repo is not registered.
 */
export async function getRepo(
  registryPath: string,
  name: string,
): Promise<RepoMeta | null> {
  const registry = await loadRegistry(registryPath);
  return registry.repos[name] ?? null;
}

/**
 * List all registered repos.
 */
export async function listRepos(
  registryPath: string,
): Promise<RepoMeta[]> {
  const registry = await loadRegistry(registryPath);
  return Object.values(registry.repos);
}

/**
 * Partially update a repo's metadata (e.g., last_git_commit after freshness check).
 */
export async function updateRepoMeta(
  registryPath: string,
  repoName: string,
  updates: Partial<Pick<RepoMeta, "last_git_commit" | "symbol_count" | "file_count" | "updated_at">>,
): Promise<void> {
  return withRegistryLock(registryPath, async () => {
    const registry = await loadRegistry(registryPath);
    const existing = registry.repos[repoName];
    if (!existing) return;
    Object.assign(existing, updates);
    registry.updated_at = Date.now();
    await saveRegistry(registryPath, registry);
  });
}

/**
 * Remove a repo from the registry.
 * Returns true if the repo existed and was removed, false otherwise.
 */
export async function removeRepo(
  registryPath: string,
  name: string,
): Promise<boolean> {
  return withRegistryLock(registryPath, async () => {
    const registry = await loadRegistry(registryPath);

    if (!(name in registry.repos)) {
      return false;
    }

    delete registry.repos[name];
    registry.updated_at = Date.now();
    await saveRegistry(registryPath, registry);
    return true;
  });
}

/**
 * Resolve registry metadata for a repo input string.
 * When `repoInput` is empty, uses CWD-based name then single-repo / root-path fallbacks.
 * When `repoInput` is non-empty but the exact key misses, falls back to:
 *   1. "local/<input>" (agents passing bare basename like "thepopebot")
 *   2. unique suffix match on "<prefix>/<input>" across all registered repos
 *   3. unique basename(root) === input match (handles .codesift.json overrides)
 * Ambiguous matches (>1 candidate) return null instead of guessing.
 */
export async function resolveRegisteredRepoMeta(
  registryPath: string,
  repoInput: string,
): Promise<{ resolvedName: string; meta: RepoMeta } | null> {
  let resolved = repoInput;
  if (!resolved) {
    resolved = getRepoName(process.cwd());
  }
  let meta = await getRepo(registryPath, resolved);
  if (!meta && !repoInput) {
    const cwd = process.cwd();
    const allRepos = await listRepos(registryPath);
    const byRoot = allRepos.find((r) => r.root === cwd);
    if (byRoot) {
      resolved = byRoot.name;
      meta = byRoot;
    } else if (allRepos.length === 1) {
      resolved = allRepos[0]!.name;
      meta = allRepos[0]!;
    }
  }
  if (!meta && repoInput) {
    const allRepos = await listRepos(registryPath);
    const explicitMatches = resolveExplicitRepoInput(allRepos, repoInput);
    if (explicitMatches.length === 1) {
      meta = explicitMatches[0]!;
      resolved = meta.name;
    }
  }
  if (!meta && repoInput && !repoInput.includes("/")) {
    // Bare-name fallback: agent passed `thepopebot` but registry has `local/thepopebot`.
    // Collect every repo whose name ends in `/<input>` and decide on the union to avoid
    // silently picking `local/widget` when `team/widget` also exists.
    const allRepos = await listRepos(registryPath);
    const suffixMatches = allRepos.filter((r) => r.name.endsWith(`/${repoInput}`));
    if (suffixMatches.length === 1) {
      resolved = suffixMatches[0]!.name;
      meta = suffixMatches[0]!;
    } else if (suffixMatches.length === 0) {
      const byBasename = allRepos.filter((r) => basename(r.root) === repoInput);
      if (byBasename.length === 1) {
        resolved = byBasename[0]!.name;
        meta = byBasename[0]!;
      }
    }
  }
  if (!meta) return null;
  return { resolvedName: resolved, meta };
}

function resolveExplicitRepoInput(repos: RepoMeta[], repoInput: string): RepoMeta[] {
  if (isAbsolute(repoInput)) {
    const inputPath = resolve(repoInput);
    const matches = repos
      .filter((r) => isAncestorOrEqual(resolve(r.root), inputPath))
      .sort((a, b) => resolve(b.root).length - resolve(a.root).length);
    const longestRootLength = matches[0] ? resolve(matches[0].root).length : 0;
    return matches.filter((r) => resolve(r.root).length === longestRootLength);
  }

  const lowerInput = repoInput.toLowerCase();
  const caseMatches = repos.filter((r) => r.name.toLowerCase() === lowerInput);
  if (caseMatches.length > 0) return caseMatches;

  const localPrefix = "local/";
  if (lowerInput.startsWith(localPrefix)) {
    const requestedBasename = repoInput.slice(localPrefix.length).toLowerCase();
    return repos.filter((r) => basename(r.root).toLowerCase() === requestedBasename);
  }

  return [];
}

function isAncestorOrEqual(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const prefix = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
  return descendant.startsWith(prefix);
}

/**
 * Derive a repo name from its root path. Tried in order:
 *
 *   1. `.codesift.json` override file at the repo root (escape hatch for
 *      collisions or non-git repos that need a fixed name):
 *        { "name": "tgm-survey-platform" }      -> "local/tgm-survey-platform"
 *        { "name": "team/tgm-survey-platform" } -> "team/tgm-survey-platform"
 *
 *   2. `git remote.origin.url` parsed from `.git/config`. The same clone on
 *      any machine resolves to the same name regardless of CWD basename, so
 *      `~/workspace` on a VPS and `~/projects/tgm-survey-platform` locally
 *      both register as `local/tgm-survey-platform`. Supported URL forms:
 *        git@github.com:owner/repo.git
 *        https://github.com/owner/repo(.git)
 *        ssh://git@host/owner/repo.git
 *        git://host/owner/repo
 *      Subgroups (GitLab) collapse to the trailing repo segment.
 *
 *   3. Fallback `local/{basename(repoRoot)}` for non-git directories or
 *      git repos without an `origin` remote.
 *
 * Failures at each step (missing file, malformed JSON, unparseable URL) fall
 * through silently to the next step — derivation must never throw.
 */
export function getRepoName(repoRoot: string): string {
  const worktree = linkedWorktree(repoRoot);
  // Base name from the MAIN checkout, not from the worktree: a linked worktree has no
  // `.git/config` of its own (the config lives in the main repo), so deriving locally would fall
  // through to the worktree's own basename and every worktree of one repo would get an unrelated
  // name. Taking the base from the main checkout keeps them grouped under one prefix and differing
  // only by the suffix — which is what makes the set readable in `list_repos`.
  if (worktree) return `${baseRepoName(worktree.mainRoot)}@${worktree.name}`;
  return baseRepoName(repoRoot);
}

function baseRepoName(repoRoot: string): string {
  const override = readNameOverride(repoRoot);
  if (override) return override;

  const fromGit = readGitOriginRepoName(repoRoot);
  if (fromGit) return `local/${fromGit}`;

  return `local/${basename(repoRoot)}`;
}

/**
 * The git worktree identifier when `repoRoot` is a LINKED worktree, else null.
 *
 * Every one of the three name sources above collapses a repo's worktrees onto a single name, and
 * the registry is keyed by name — so the last one indexed silently evicts the rest. Measured on
 * this machine: `tgm-survey-platform` has **36 worktrees**, all carrying the same TRACKED
 * `.codesift.json` (`{"name":"tgm-survey-platform"}`), so 35 registry entries were being
 * overwritten. The override file is documented as the escape hatch FOR collisions; committing it
 * makes it the cause of one, because git checks it out into every worktree.
 *
 * `git remote.origin.url` collapses them for the same reason (worktrees share the remote), and
 * even the basename fallback collides whenever two worktrees are named alike under different
 * parents.
 *
 * This is the H19 hazard as a persistent condition rather than a transient one: an agent working
 * in one worktree resolves the repo by name and gets whichever tree registered last. Disambiguating
 * here fixes all three sources at once, because it is applied to the result rather than to any of
 * them.
 *
 * Detection is the presence of a `.git` FILE (linked worktrees get a file containing
 * `gitdir: …/.git/worktrees/<name>`; a main checkout gets a directory). The trailing segment is
 * git's own worktree name, which git already guarantees unique within the repository — safer than
 * the directory basename, which is not.
 */
function linkedWorktree(repoRoot: string): { name: string; mainRoot: string } | null {
  const dotGit = join(repoRoot, ".git");
  try {
    if (!statSync(dotGit).isFile()) return null; // main checkout, or no git at all
    const pointer = readFileSync(dotGit, "utf-8").trim();
    const match = pointer.match(/^gitdir:\s*(.+)$/m);
    if (!match?.[1]) return null;
    const raw = match[1].trim().replace(/[/\\]+$/, "");
    // `gitdir:` is normally absolute but git permits a relative pointer.
    const gitdir = isAbsolute(raw) ? raw : resolve(repoRoot, raw);
    // Only a worktree pointer qualifies. Submodules also use a `.git` file, and their gitdir
    // points at `…/.git/modules/<name>` — a submodule is a different repository with its own
    // remote, so it already gets a distinct name and must not be suffixed onto its parent's.
    const split = gitdir.split(/[/\\]\.git[/\\]worktrees[/\\]/);
    if (split.length !== 2) return null;
    const mainRoot = split[0];
    const name = split[1]?.split(/[/\\]/)[0];
    if (!mainRoot || !name) return null;
    return { name, mainRoot };
  } catch {
    return null; // derivation must never throw
  }
}

function readNameOverride(repoRoot: string): string | null {
  const overridePath = join(repoRoot, ".codesift.json");
  if (!existsSync(overridePath)) return null;
  try {
    const cfg = JSON.parse(readFileSync(overridePath, "utf-8")) as { name?: unknown };
    if (typeof cfg.name !== "string") return null;
    const trimmed = cfg.name.trim();
    if (trimmed.length === 0) return null;
    return trimmed.includes("/") ? trimmed : `local/${trimmed}`;
  } catch {
    return null;
  }
}

/**
 * Extract the repo segment from `.git/config`'s `[remote "origin"] url`.
 * Returns the bare repo name (e.g. "tgm-survey-platform") or null.
 *
 * Skips worktrees and submodules (`.git` is a file, not a directory) — those
 * fall back to basename and can be pinned via `.codesift.json` if needed.
 */
function readGitOriginRepoName(repoRoot: string): string | null {
  const configPath = join(repoRoot, ".git", "config");
  if (!existsSync(configPath)) return null;
  try {
    const url = parseOriginUrl(readFileSync(configPath, "utf-8"));
    return url ? extractRepoSegment(url) : null;
  } catch {
    return null;
  }
}

function parseOriginUrl(configText: string): string | null {
  // git config sections: `[remote "origin"]` then `\turl = ...` until next `[...]` header.
  const lines = configText.split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]\s*$/.test(trimmed);
      continue;
    }
    if (!inOrigin) continue;
    const match = trimmed.match(/^url\s*=\s*(.+?)\s*$/);
    if (match) return match[1] ?? null;
  }
  return null;
}

function extractRepoSegment(url: string): string | null {
  let path = url.trim();
  // Strip protocol: scheme://[user@]host/...  OR  user@host:path  (SSH shorthand).
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "");
  path = path.replace(/^[^@\s:]+@[^:]+:/, "");
  // Strip trailing slashes and the conventional .git suffix.
  path = path.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (path.length === 0) return null;
  const segments = path.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (!last) return null;
  // Sanity: forbid anything that would produce a weird registry key.
  if (!/^[A-Za-z0-9._-]+$/.test(last)) return null;
  return last;
}

function emptyRegistry(): Registry {
  return { repos: {}, updated_at: Date.now() };
}

function isValidRegistry(value: unknown): value is Registry {
  if (typeof value !== "object" || value === null) return false;

  const obj = value as Record<string, unknown>;
  if (typeof obj["repos"] !== "object" || obj["repos"] === null) return false;
  if (typeof obj["updated_at"] !== "number") return false;

  return true;
}
