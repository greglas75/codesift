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
 * So the CWD has to travel with the request rather than with the process. The
 * daemon asks each client for its MCP roots once per session and runs that
 * session's requests inside this context; stdio callers get an empty store and
 * fall through to `process.cwd()`, exactly as before.
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
