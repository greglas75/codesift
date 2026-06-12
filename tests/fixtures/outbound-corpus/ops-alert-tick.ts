/**
 * ops-alert-tick — debounced Teams ping on critical ops events.
 *
 * Every 30 min (staggered off the :00 pile) we look at the `events` table for
 * NEW critical events since `ops_alert_state.last_teams_alert_at`. If there are
 * any, we post ONE Adaptive Card summary to the bound Teams chat and advance the
 * debounce marker — so a burst of critical events yields at most one ping per
 * 30-min window (the next tick re-summarizes only what arrived after the ping).
 *
 * Best-effort by design: a Teams POST failure must NEVER throw out of the tick
 * (the host worker loop keeps going) and must NOT advance the marker — the next
 * tick retries the same window.
 *
 * Flag-gated by `isOpsAlertsTeamsEnabled()` (env `OPS_ALERTS_TEAMS_ENABLED`).
 * The job is ALWAYS registered; it returns early when the flag is off so
 * toggling the flag needs no worker restart-for-registration.
 *
 * Critical classification is resolved EXACTLY as the ops-events list/alerts
 * surfaces do (IC-1, one source): SELECT DISTINCT type, classify each in TS via
 * `classifyEvent`, keep the ones whose severity === 'critical'.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import { resolveTypesBySeverity } from '@/lib/ops-events/resolve-types';
import { isOpsAlertsTeamsEnabled } from '@/lib/db/settings';
import type { AdaptiveCard, AdaptiveElement } from '@/lib/teams/types';

/**
 * Same call shape as bot-connector's `postCardViaBot`, but the worker must
 * NEVER import the real one: `@/lib/teams/bot-connector` begins with
 * `import 'server-only'`, which throws under the worker's tsx runtime and
 * crash-loops the container (took prod polling down 2026-06-10). The default
 * sender posts through the web service's internal post-card route instead —
 * same pattern as teams-pull-report.
 */
type PostCardFn = (
  card: AdaptiveCard,
  chatId: string,
  serviceUrl: string,
) => Promise<string>;

export interface OpsAlertTickSummary {
  ok: boolean;
  reason: 'disabled' | 'unbound' | 'no_new_critical' | 'pinged' | 'post_failed';
  pinged: boolean;
  /** Number of NEW critical events found this tick (only set when > 0). */
  criticalCount?: number;
}

export interface OpsAlertTickDeps {
  /** Injectable for tests — defaults to the web-relayed Bot Connector POST. */
  postCard?: PostCardFn;
}

/**
 * Default sender: relay the card to the web service's internal post-card
 * route, where bot-connector's `server-only` chain is valid. Bearer-authed
 * with INTERNAL_API_SECRET. Reads process.env DIRECTLY — NOT via
 * @/lib/teams/env, which carries the `server-only` guard.
 */
async function requestWebPostCard(
  card: AdaptiveCard,
  chatId: string,
  serviceUrl: string,
): Promise<string> {
  const baseUrl = (process.env.INTERNAL_WEB_URL ?? 'http://web:3000').replace(
    /\/+$/,
    '',
  );
  const secret = process.env.INTERNAL_API_SECRET ?? '';
  const res = await fetch(`${baseUrl}/api/internal/teams/post-card`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ card, chatId, serviceUrl }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`web post-card failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => ({}))) as {
    activityId?: unknown;
  };
  return typeof json.activityId === 'string' ? json.activityId : '';
}

/** Epoch sentinel — a never-pinged state counts ALL critical events as new. */
const EPOCH = '1970-01-01T00:00:00.000Z';

interface AlertStateRow {
  teams_chat_id: string | null;
  teams_service_url: string | null;
  last_teams_alert_at: string | null;
  scan_bound: string;
  [key: string]: unknown;
}

export async function runOpsAlertTick(
  db: Database,
  deps: OpsAlertTickDeps = {},
): Promise<OpsAlertTickSummary> {
  if (!isOpsAlertsTeamsEnabled()) {
    return { ok: true, reason: 'disabled', pinged: false };
  }

  // Capture scan_bound in the SAME query as the state read so that both
  // the DISTINCT-types query and the COUNT/MAX query use the identical
  // timestamp — no split-read TOCTOU drift between two now() evaluations.
  const stateResult = await db.execute<AlertStateRow>(sql`
    SELECT teams_chat_id,
           teams_service_url,
           last_teams_alert_at::text AS last_teams_alert_at,
           GREATEST(
             COALESCE(last_teams_alert_at, ${EPOCH}::timestamptz),
             now() - interval '7 days'
           )::text AS scan_bound
      FROM ops_alert_state
     WHERE id = 1
  `);
  const state = stateResult.rows[0];
  if (!state || !state.teams_chat_id || !state.teams_service_url) {
    return { ok: true, reason: 'unbound', pinged: false };
  }

  // Fixed lower bound captured above — both queries below use this same value.
  const scanBound = state.scan_bound;

  // Distinct critical event types newer than the effective marker — classify in
  // TS (IC-1) via the shared resolver. The resolver's `ORDER BY type` yields the
  // same ascending order as the old in-TS `.sort()`.
  const criticalTypes = await resolveTypesBySeverity(
    db,
    (s) => s === 'critical',
    scanBound,
  );

  if (criticalTypes.length === 0) {
    return { ok: true, reason: 'no_new_critical', pinged: false };
  }

  // Count the underlying critical events + capture MAX(occurred_at) for the
  // marker-advance (TOCTOU fix: advance to max scanned, not now()).
  const typeParams = criticalTypes.map((t) => sql`${t}`);
  const inList = sql.join(typeParams, sql`, `);
  const countResult = await db.execute<{ n: string; max_occurred: string }>(sql`
    SELECT COUNT(*)::text AS n,
           MAX(occurred_at)::text AS max_occurred
      FROM events
     WHERE occurred_at > ${scanBound}::timestamptz
       AND type IN (${inList})
  `);
  const criticalCount = Number(countResult.rows[0]?.n ?? '0');
  const maxOccurred = countResult.rows[0]?.max_occurred ?? new Date().toISOString();

  const card = buildOpsAlertCard(criticalCount, criticalTypes, state.last_teams_alert_at);
  const post = deps.postCard ?? requestWebPostCard;

  try {
    await post(card, state.teams_chat_id, state.teams_service_url);
  } catch (e) {
    // Best-effort: never throw out of the tick, never advance the marker.
     
    console.error('[ops-alert-tick] Teams post failed:', e);
    return { ok: false, reason: 'post_failed', pinged: false };
  }

  // Advance marker to the max occurred_at of this scan's critical events (TOCTOU
  // fix): any event that arrived DURING the POST (occurred_at > maxOccurred) will
  // still be caught on the next tick.
  await db.execute(sql`
    UPDATE ops_alert_state SET last_teams_alert_at = ${maxOccurred}::timestamptz WHERE id = 1
  `);

  return { ok: true, reason: 'pinged', pinged: true, criticalCount };
}

/** Build a freeform Adaptive Card summarizing the new critical ops alerts. */
function buildOpsAlertCard(
  count: number,
  types: string[],
  since: string | null,
): AdaptiveCard {
  const body: AdaptiveElement[] = [
    {
      type: 'TextBlock',
      text: `⚠️ ${count} critical ops alert(s)`,
      weight: 'Bolder',
      size: 'Large',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: `since ${since ?? 'start'}`,
      isSubtle: true,
      spacing: 'None',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: types.map((t) => `• ${t}`).join('\n'),
      wrap: true,
    },
  ];

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body,
  };
}
