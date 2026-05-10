// Shared wall-clock cap helpers. Used by hot search paths whose telemetry
// shows occasional 5-15 minute runaway calls (broad queries on huge repos,
// cold semantic embeddings). The cap returns control to the agent quickly
// with an actionable hint instead of hanging the conversation.

const TIMEOUT = Symbol("codesift.wall-clock.timeout");

/**
 * Race a promise against a wall-clock timer. On timeout, resolves to the
 * sentinel returned by `onTimeout`. The original work continues to completion
 * and is discarded — there is no cancellation token plumbed through the
 * search pipeline. That is intentional: cancellation would require touching
 * every async leaf in the codebase. Discarding the result is sufficient.
 */
export function raceWallClock<T, R>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => R,
): Promise<T | R> {
  return Promise.race([
    work,
    new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), ms)),
  ]).then((v) => (v === TIMEOUT ? onTimeout() : (v as T)));
}
