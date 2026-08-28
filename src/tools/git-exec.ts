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
  const { stdout } = await execFileAsync("git", args, {
    cwd: options.cwd,
    encoding: "utf-8",
    timeout: options.timeout,
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
  });
  return stdout;
}
