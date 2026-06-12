import type { Database } from '@/lib/db/client';
import { listClonesByProject } from '@/lib/db/clones';
import { isTeamsBotSendEnabledDb } from '@/lib/db/settings';
import { pollClone } from './poll-clone';

/**
 * "Pull Fieldwork Report" worker job. Re-polls a project's clones with the SAME
 * core the Refresh button's poll-clone jobs run (`pollClone` — advisory-locked
 * per clone, never zeros counters on failure), then asks the WEB service to
 * post the report card to the project's bound Teams chat.
 *
 * Two deliberate design choices, both learned the hard way:
 *
 * 1. Poll INLINE (not enqueue-poll-jobs-then-wait). The worker pool is shared
 *    (concurrency ~2). A job that enqueued poll-clone jobs and then BLOCKED
 *    waiting for them would hold a worker slot the very poll-clone jobs need to
 *    run → pool deadlock. Calling pollClone directly does the poll in THIS
 *    job's own slot, so there is no cross-job wait. pollClone is the exact core
 *    a poll-clone job runs, so this is "the same refresh", not a reinvented
 *    poller.
 *
 * 2. The SEND is an HTTP call to the web service, NOT done in-process. The card
 *    sender (@/lib/teams/send-via-bot) and its whole chain begin with `import
 *    'server-only'`, which throws under the worker's tsx runtime (no Next
 *    bundler here to alias server-only to a no-op) — importing it crash-loops
 *    the ENTIRE worker. So the worker stays server-only-free and delegates the
 *    send to a bearer-authed web route running inside the Next server, where
 *    server-only is valid.
 */

/** Bounded re-poll fan-out — drains a multi-country project quickly without
 *  exceeding the worker's own TGM poll concurrency. */
const POLL_CONCURRENCY = 3;

/** Who asked for this send — forwarded to the web route so it can gate the
 *  daily-auto-report switch on `'auto'` only (human pulls always send). */
export type TeamsPullReportSource = 'auto' | 'manual';

export interface TeamsPullReportDeps {
  /** Re-poll one clone. Real impl: pollClone(db, id, {triggeredBy:'manual'}). */
  poll?: (db: Database, cloneId: number) => Promise<unknown>;
  /** Ask the web service to post the project's card to its bound chat. */
  sendCard?: (projectId: number, source: TeamsPullReportSource) => Promise<void>;
  /** Daily-auto-report kill switch; defaults to the DB flag. Injectable for tests. */
  isSendEnabled?: (db: Database) => Promise<boolean>;
}

/**
 * Best-effort, bounded-concurrency re-poll of every clone of a project. A single
 * clone's failure is caught + logged and never aborts the rest — pollClone keeps
 * the last good snapshot on failure, so partial freshness beats the prior state.
 */
async function repollProject(
  db: Database,
  projectId: number,
  poll: (db: Database, cloneId: number) => Promise<unknown>,
): Promise<void> {
  const projectClones = await listClonesByProject(db, projectId);
  let next = 0;
  async function lane(): Promise<void> {
    while (next < projectClones.length) {
      const clone = projectClones[next++];
      if (!clone) break;
      try {
        await poll(db, clone.id);
      } catch (err) {
        console.error(
          `[teams-pull-report] poll failed for clone ${clone.id} (project ${projectId}) — continuing:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  const laneCount = Math.min(POLL_CONCURRENCY, projectClones.length);
  await Promise.all(Array.from({ length: laneCount }, () => lane()));
}

/**
 * Default sender: POST the project id to the web service's internal send-card
 * route. The card is built + posted there (server-only is valid in the Next
 * server). Bearer-authed with INTERNAL_API_SECRET. Reads process.env DIRECTLY —
 * NOT via @/lib/teams/env, which carries the `server-only` guard.
 */
async function requestWebSendCard(
  projectId: number,
  source: TeamsPullReportSource,
): Promise<void> {
  const baseUrl = (process.env.INTERNAL_WEB_URL ?? 'http://web:3000').replace(
    /\/+$/,
    '',
  );
  const secret = process.env.INTERNAL_API_SECRET ?? '';
  const res = await fetch(`${baseUrl}/api/internal/teams/send-card`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ projectId, source }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`web send-card failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

export async function runTeamsPullReport(
  db: Database,
  args: { projectId: number; source?: TeamsPullReportSource },
  deps: TeamsPullReportDeps = {},
): Promise<void> {
  const poll =
    deps.poll ?? ((d, id) => pollClone(d, id, { triggeredBy: 'manual' }));
  const sendCard = deps.sendCard ?? requestWebSendCard;
  const isSendEnabled = deps.isSendEnabled ?? isTeamsBotSendEnabledDb;
  // Default to 'auto' when the payload predates this field — fail-safe: an
  // un-tagged job is treated as the scheduled report, so the kill switch governs
  // it. The known human path (the Pull command) always tags 'manual' explicitly.
  const source: TeamsPullReportSource = args.source ?? 'auto';

  // Gate 'auto' at the WORKER, BEFORE the repoll: a job queued just before a
  // mid-burst disable completes cleanly — no TGM repoll, no send, no 503 →
  // pg-boss retry storm. 'manual' (human Pull) is never gated.
  if (source === 'auto' && !(await isSendEnabled(db))) {
    return;
  }

  // 1. Fresh data first — re-poll the whole project (best-effort).
  await repollProject(db, args.projectId, poll);

  // 2. Then ask web to post the card. A throw here (no bound chat / send
  //    failure) propagates so pg-boss records the job failure.
  await sendCard(args.projectId, source);
}
