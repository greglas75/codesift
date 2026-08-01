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

/** True when a request context is active — used to tell daemon from stdio. */
export function hasRequestContext(): boolean {
  return storage.getStore() !== undefined;
}
