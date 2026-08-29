import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run `git` WITHOUT blocking the event loop.
 *
 * Every git call on a tool request path used `execFileSync`, which stops the whole process until
 * the child exits. Under stdio that was invisible — one server per client, so a slow `git log` only
 * delayed the client that asked for it. The shared HTTP daemon is one process for every client on
 * the machine, so the same call freezes ALL of them.
 *
 * Measured on the live daemon 2026-08-29, sampling the main thread during a stall: 10% of
 * main-thread time inside `node::SyncProcessRunner::Spawn`, 9% of it parked in `kevent` waiting for
 * the child. Clients saw `/health` time out and reported a dead server; the daemon recovered on its
 * own the moment the child exited, which is the signature of a blocking call rather than a hang.
 * The worst offender allowed the child 30 SECONDS (`git log --name-only` over months of history).
 *
 * Array form, never a shell string — the injection guard the previous call sites carried as
 * SEC-002/R-1 and which must survive this change.
 */
export interface RunGitOptions {
  cwd: string;
  /** Milliseconds before the child is killed. Same values the sync calls used. */
  timeout: number;
  /** Node's default is 1 MB, which overflows on large repositories. */
  maxBuffer?: number;
}

/**
 * stdout as a string, or a throw carrying git's own message.
 *
 * The message shape is preserved deliberately: callers match on `ENOBUFS`/`maxBuffer` to tell
 * "history too large" from "git failed", and one of them degrades gracefully on exactly that.
 */
export async function runGit(args: string[], options: RunGitOptions): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: options.cwd,
      encoding: "utf-8",
      timeout: options.timeout,
      ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    });
    return stdout;
  } catch (err: unknown) {
    // A KILLED child and a FAILING git look identical from the caller's side: both arrive as
    // "Command failed: git …" and, when git wrote nothing to stderr, with no further detail.
    // Measured 2026-08-30: `review_diff` reported `Git diff failed: Command failed: git diff
    // --name-only HEAD~1..HEAD` on a repository where that exact command succeeds from a shell in
    // 0.1 s — it had simply exceeded its ceiling on a loaded machine, and the message sent me
    // looking for a git fault that did not exist.
    //
    // Timeouts and failures need different responses (raise the ceiling / narrow the range, versus
    // fix the refs), so they must not read the same.
    const timedOut = describeGitTimeout(err, args, options);
    if (timedOut) throw new Error(timedOut);
    throw err;
  }
}

/**
 * Was this a killed child rather than a failing git — and if so, say so.
 *
 * Separated from `runGit` so the classification can be tested without racing a real timeout: a test
 * that sets `timeout: 1` and hopes the child is still alive passes alone and fails under load,
 * which makes it a coin toss rather than a contract.
 *
 * Returns the message to throw, or null when this was a genuine git failure.
 */
export function describeGitTimeout(
  err: unknown,
  args: string[],
  options: RunGitOptions,
): string | null {
  const killed = (err as { killed?: boolean } | null)?.killed === true;
  const signal = (err as { signal?: string | null } | null)?.signal;
  if (!killed && signal !== "SIGTERM") return null;
  return (
    `git ${args[0] ?? ""} exceeded its ${options.timeout} ms limit in ${options.cwd}` +
    `${signal ? ` (killed by ${signal})` : ""} — the command did not fail, it ran out of time`
  );
}
