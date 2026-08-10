import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Anonymous rollup of zuvo retrospectives, so the install base can report WHERE WORK GOES WRONG —
 * not just which tools were called.
 *
 * Why this rides the codesift payload instead of getting its own channel: the zuvo channel cannot
 * collect from anyone. Its sender ships over SSH to a tailnet-only address, and the collector's
 * public `/ingest/zuvo` requires a secret, deliberately — the collector's own comment says those
 * namespaces "carry repo names and debt text". Measured 2026-08-06: `/ingest/zuvo` and
 * `/ingest/backlog` hold exactly ONE anon_id each (this machine), while `/ingest/codesift` — open,
 * anonymous, no token — has 11 external installs and 11,873 tool calls. The channel that works is
 * the one to use.
 *
 * A retro line is 17 tab-separated fields, and 12 of them are already enums or counts. The other
 * five identify: project, branch, commit sha, and a free-text "missing template" note. Those are
 * NOT sanitised here — they are never read into the aggregate at all. Anonymity by omission
 * survives someone later adding a field to the source format; anonymity by scrubbing does not.
 */

/** Field positions in a canonical `retros.log` line (0-based, after the `RETRO: <ts>` field). */
const F = {
  TS: 0,
  SKILL: 1,
  // 2 = project        — identifies the repo
  CODE_TYPE: 3,
  FRICTION: 4,
  // 5 = missing-template — free prose written by the agent
  CONTEXT_GAP: 6,
  TURNS: 7,
  TOOL_CALLS: 8,
  FILES_READ: 9,
  FILES_MODIFIED: 10,
  // 11 = branch        — often names a ticket or a customer
  // 12 = sha7          — a commit hash is a fingerprint of a specific repo
  BLIND_AUDIT: 13,
  ADVERSARIAL: 14,
  CODESIFT: 15,
  ROUTING: 16,
} as const;

const FIELD_COUNT = 17;

/** One day's worth of retros for one (skill, outcome-shape) combination. */
export interface RetroAggregate {
  day: string;
  skill: string;
  code_type: string;
  friction: string;
  context_gap: string;
  codesift: string;
  routing: string;
  count: number;
  /** Medians, not sums: a total would leak how much work this install does. */
  median_turns: number;
  median_tool_calls: number;
  median_files_read: number;
  median_files_modified: number;
  /** How many of these runs ran each safety gate to a real verdict. */
  blind_audit_ran: number;
  adversarial_ran: number;
  /**
   * How many declared the gate INAPPLICABLE (`N/A`) — the skill has no such step.
   * Kept separate from "did not run" on purpose: "this skill has no blind audit"
   * and "this skill has one and skipped it" are different product facts, and
   * collapsing them is what made this column unreadable in the first place.
   * A consumer wanting a compliance rate should use ran / (count - na).
   */
  blind_audit_na: number;
  adversarial_na: number;
}

/**
 * Values that mean "this gate did not produce a verdict".
 *
 * `skipped` / `not_run` / `blocked*` are the answers worth counting SEPARATELY from a clean pass —
 * a fleet where the adversarial gate is mostly skipped is a different product problem from one
 * where it runs and finds nothing.
 */
const GATE_NOT_RUN = new Set(["skipped", "not_run", "blocked", "blocked_infra", "-", ""]);
/**
 * `N/A` = the skill has no such step, so there is nothing to run. It is NOT a verdict and NOT a
 * skip. Before 2026-08-06 zuvo's append-retro had no N/A in the blind-audit enum at all, so skills
 * without the step were forced to file a verdict-shaped value — 108 of 164 recorded verdicts (66%)
 * came from skills whose SKILL.md never mentions a blind audit. Once zuvo started emitting N/A,
 * gateRan() would have counted it as a real verdict (it is not in GATE_NOT_RUN), turning the fix
 * into a worse metric than the bug. Hence its own set and its own counter.
 */
const GATE_NOT_APPLICABLE = new Set(["n/a", "na"]);

function gateNotApplicable(value: string): boolean {
  return GATE_NOT_APPLICABLE.has(value.trim().toLowerCase());
}

/**
 * Collapse anything that is not a short, enum-shaped token to `"other"`.
 *
 * `append-retro` validates these columns against fixed case lists, so in practice they are already
 * enums. In practice is not a guarantee: `retros.log` is a plain text file and a hand-appended or
 * future-format line can put arbitrary prose at any position. Without this, one such line would
 * carry a sentence — possibly naming a repo or a customer — onto an ANONYMOUS endpoint, and the
 * whole basis for riding that endpoint would be gone.
 *
 * Bounded length and a conservative character class, so anonymity holds by construction rather
 * than by trusting the writer.
 */
const ENUMISH = /^[A-Za-z0-9][A-Za-z0-9_:.\/-]{0,31}$/;

function enumish(value: string | undefined): string {
  const v = (value ?? "").trim();
  if (v === "") return "";
  return ENUMISH.test(v) ? v : "other";
}

function gateRan(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v.length > 0 && !GATE_NOT_RUN.has(v) && !GATE_NOT_APPLICABLE.has(v) && !v.startsWith("blocked");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : (sorted[mid] ?? 0);
}

function dayOf(tsField: string): string | null {
  // `RETRO: 2026-08-05T23:46:44Z` — take the date, drop the clock. Time-of-day plus a repo-sized
  // event count is enough to correlate one install's activity against a public commit history.
  const match = tsField.match(/(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

/**
 * Read and aggregate `~/.zuvo/retros.log`.
 *
 * Returns [] when zuvo is not installed, which is the common case for a codesift user — this must
 * never be an error, only an absence.
 */
export interface RetroScan {
  rows: RetroAggregate[];
  /**
   * Newest retro timestamp actually seen in the log (0 when none). Retained for callers that need
   * event-time filtering; the uploader uses nextOffset because append order is reliable when
   * clocks are not.
   */
  maxTs: number;
  /** Byte offset immediately after the last complete line considered by an offset scan. */
  nextOffset: number;
}

export async function aggregateRetros(
  sinceTs = 0,
  logPath = join(homedir(), ".zuvo", "retros.log"),
): Promise<RetroAggregate[]> {
  return (await scanRetros(sinceTs, logPath)).rows;
}

export async function scanRetros(
  sinceTs = 0,
  logPath = join(homedir(), ".zuvo", "retros.log"),
  cursor: "timestamp" | "offset" = "timestamp",
): Promise<RetroScan> {
  let file: Buffer;
  try {
    file = await readFile(logPath);
  } catch {
    return { rows: [], maxTs: 0, nextOffset: cursor === "offset" ? sinceTs : 0 };
  }
  let raw: string;
  let nextOffset = file.length;
  const filterSinceTs = cursor === "timestamp" ? sinceTs : 0;
  if (cursor === "offset") {
    const start = sinceTs >= 0 && sinceTs <= file.length ? sinceTs : 0;
    const unread = file.subarray(start);
    const finalNewline = unread.lastIndexOf(0x0a);
    if (finalNewline < 0) {
      raw = "";
      nextOffset = start;
    } else {
      raw = unread.subarray(0, finalNewline + 1).toString("utf-8");
      nextOffset = start + finalNewline + 1;
    }
  } else {
    raw = file.toString("utf-8");
  }
  let maxTs = 0;

  type Bucket = Omit<
    RetroAggregate,
    "count" | "median_turns" | "median_tool_calls" | "median_files_read" | "median_files_modified"
  > & { turns: number[]; toolCalls: number[]; filesRead: number[]; filesModified: number[] };

  const buckets = new Map<string, Bucket>();

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("RETRO:")) continue;
    const f = line.split("\t");
    // Length is the format check. A drifted line (free prose, an older column count) is skipped
    // rather than parsed by position — reading position 13 of a 9-field line would report whatever
    // happened to be there as an audit verdict.
    if (f.length !== FIELD_COUNT) continue;

    const day = dayOf(f[F.TS] ?? "");
    if (!day) continue;
    const at = Date.parse((f[F.TS] ?? "").replace(/^RETRO:\s*/, ""));
    // Track the newest timestamp across EVERY well-formed line, including ones this call filters
    // out. The watermark must clear lines already sent, otherwise each flush rescans them.
    if (Number.isFinite(at) && at > maxTs) maxTs = at;
    // `<=`, not `<`: the watermark stores the newest ts already sent, so a line sitting exactly on
    // it was in the previous payload and would otherwise be re-sent on every flush forever.
    if (filterSinceTs > 0 && Number.isFinite(at) && at <= filterSinceTs) continue;

    // Group on the NORMALISED values, not the raw ones: two lines whose prose differs both store
    // `"other"`, so keying on the raw text would emit two aggregate rows with identical content.
    const dims = {
      skill: enumish(f[F.SKILL]),
      code_type: enumish(f[F.CODE_TYPE]),
      friction: enumish(f[F.FRICTION]),
      context_gap: enumish(f[F.CONTEXT_GAP]),
      codesift: enumish(f[F.CODESIFT]),
      routing: enumish(f[F.ROUTING]),
    };
    // Joined on a separator that cannot occur in an enum-shaped token, so two different dimension
    // tuples can never collide into one bucket.
    const key = [day, ...Object.values(dims)].join("|")

    let b = buckets.get(key);
    if (!b) {
      b = {
        day,
        ...dims,
        blind_audit_ran: 0,
        blind_audit_na: 0,
        adversarial_na: 0,
        adversarial_ran: 0,
        turns: [],
        toolCalls: [],
        filesRead: [],
        filesModified: [],
      };
      buckets.set(key, b);
    }

    const num = (i: number): number => {
      const n = Number(f[i]);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    b.turns.push(num(F.TURNS));
    b.toolCalls.push(num(F.TOOL_CALLS));
    b.filesRead.push(num(F.FILES_READ));
    b.filesModified.push(num(F.FILES_MODIFIED));
    if (gateRan(f[F.BLIND_AUDIT] ?? "")) b.blind_audit_ran++;
    if (gateNotApplicable(f[F.BLIND_AUDIT] ?? "")) b.blind_audit_na++;
    if (gateNotApplicable(f[F.ADVERSARIAL] ?? "")) b.adversarial_na++;
    if (gateRan(f[F.ADVERSARIAL] ?? "")) b.adversarial_ran++;
  }

  const rows = [...buckets.values()]
    .map((b) => ({
      day: b.day,
      skill: b.skill,
      code_type: b.code_type,
      friction: b.friction,
      context_gap: b.context_gap,
      codesift: b.codesift,
      routing: b.routing,
      count: b.turns.length,
      median_turns: median(b.turns),
      median_tool_calls: median(b.toolCalls),
      median_files_read: median(b.filesRead),
      median_files_modified: median(b.filesModified),
      blind_audit_ran: b.blind_audit_ran,
      adversarial_ran: b.adversarial_ran,
      blind_audit_na: b.blind_audit_na,
      adversarial_na: b.adversarial_na,
    }))
    .sort((a, b) => (a.day === b.day ? a.skill.localeCompare(b.skill) : a.day.localeCompare(b.day)));
  return { rows, maxTs, nextOffset };
}
