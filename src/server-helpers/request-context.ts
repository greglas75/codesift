import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request working directory.
 *
 * Repo auto-resolution reads the process CWD, which is correct for stdio: the
 * client spawns one server per window and the server inherits that window's
 * directory. The shared HTTP daemon breaks that assumption — it is one process
 * for every client on the machine, started by launchd with CWD `/`. Before this
 * existed, every daemon-served tool call that relied on auto-resolution
 * answered `Repository "local/" not found`, because `resolveRepoFromCwd("/")`
 * matches nothing and falls back to `local/` + basename("/") = "".
 *
 * So the CWD has to travel with the request rather than with the process. It
 * travels in the URL: `setup <client> --http` writes `?cwd=<abs path>` and the
 * daemon runs that session's requests inside this context. stdio callers get an
 * empty store and fall through to `process.cwd()`, exactly as before.
 *
 * NOT from MCP roots. This comment used to say the daemon asks each client for
 * its roots once per session; nothing implements that — `roots/list` appears
 * nowhere in the server. The claim cost a reader a full investigation before the
 * grep came back empty, which is why it is called out rather than quietly
 * deleted.
 *
 * The consequence is structural and worth stating here, because it decides how
 * many processes a machine runs: an HTTP entry is inherently PER-PROJECT, since
 * one URL carries one directory. A client that keeps ONE GLOBAL MCP config
 * therefore cannot use the shared daemon at all and falls back to stdio — one
 * process per session. Measured on this machine: Claude Code, which stores MCP
 * config per project, had 114 projects on the daemon; Codex, which has only
 * ~/.codex/config.toml, had 36 stdio processes. Implementing `roots/list` is
 * what would close that gap.
 *
 * AsyncLocalStorage rather than a parameter thread because the consumers sit
 * deep under `wrapTool` — repo resolution, hint generation — and every one of
 * them would otherwise need the value passed through handlers that have no
 * business knowing about transports.
 */

export interface RequestContext {
  /** Directory the calling client is working in. */
  cwd: string;
  /**
   * Which client is asking, from `?client=` in the URL.
   *
   * Needed because clients disagree about what a good tool list is, and one daemon answers all of
   * them. Codex freezes its list at session start, so anything not offered up front is unreachable
   * for the whole session; Claude Code refreshes on demand and measurably STOPS USING CodeSift when
   * handed the full list (3e1ec6c, adoption down >90%). A single shared answer cannot satisfy both.
   *
   * It travels in the URL for the same reason `cwd` does: stateless serving has no session to have
   * learned it, and the `initialized` notification lands on an instance that never saw `initialize`
   * — measured, it arrives with an empty clientInfo.
   */
  client?: string;
  /**
   * Aborted when the client-facing timeout fires.
   *
   * `withTimeout` used to answer `timed_out` and leave the handler running:
   * measured over one day, `scan_secrets` reached 5.1 hours, `find_references`
   * 5.0 and `search_patterns` 4.9, against a 90-second budget. Nobody was
   * waiting for any of it — and an agent that gets `timed_out` usually retries
   * with a narrower scope, so the abandoned work runs ALONGSIDE its own
   * replacement. That is what put this machine's load average above 600.
   *
   * Carried here rather than threaded through every handler signature: the code
   * that can actually stop (ripgrep, directory walks) sits far below the tool
   * boundary, and ~150 handlers have no business growing a parameter for it.
   */
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `ctx` visible to `currentCwd()` for its whole async tree. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * The caller's working directory: the request's when one is in scope, the
 * process's otherwise. The fallback is what keeps stdio behaviour identical.
 */
export function currentCwd(): string {
  return storage.getStore()?.cwd ?? process.cwd();
}

/** Which client this request belongs to, when its URL said so. */
export function currentClient(): string | undefined {
  return storage.getStore()?.client;
}

/**
 * The ambient cancellation signal, if a request is in scope.
 *
 * Returns undefined outside a request (CLI, tests) so callers keep their
 * existing behaviour rather than inventing a signal that never fires.
 */
export function currentAbortSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

/** The active request context, if any — lets a wrapper extend it without losing fields. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** True when a request context is active — used to tell daemon from stdio. */
export function hasRequestContext(): boolean {
  return storage.getStore() !== undefined;
}
