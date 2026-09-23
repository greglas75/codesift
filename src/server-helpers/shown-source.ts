/**
 * Don't send the same source twice in one conversation.
 *
 * `get_symbol` / `get_symbols` / `find_and_show` / `get_context_bundle` return a symbol's full body
 * every time it is asked for, and agents ask again — a method read to understand it, then again to
 * edit it, then again inside a context bundle. Each repeat is a copy the model already holds.
 * codegraph v1.6 answers a repeat with a pointer ("unchanged") instead; this is the same idea.
 *
 * Two conditions make a pointer the WRONG answer, and both are guarded:
 *
 *  - **The conversation is not the process.** The shared HTTP daemon answers every client on the
 *    machine from one process, so "shown before" there means "shown to someone". The ledger is
 *    therefore off unless the stdio entry point turns it on — over stdio the process IS the session.
 *  - **The model no longer holds it.** Context compaction drops old tool results. The PreCompact
 *    hook touches `<dataDir>/compaction.marker`, and anything shown before the marker's mtime is
 *    treated as never shown. The marker is machine-wide, so a compaction in any session makes every
 *    session resend — the conservative direction. Entries also expire after a TTL, for hosts that
 *    compact without running hooks.
 *
 * A changed body (different hash) is always resent: the pointer claims "unchanged", so it may only
 * be given when that is true.
 *
 * **Checking and recording are separate steps.** A body counts as shown only once the caller has
 * built the whole response and knows the body survives it: `commit()` on each view, via
 * `commitDelivered`, which skips anything the response cap is about to cut. Recording at check time
 * (the first version) marked bodies as shown that formatting then failed on, that `explore` clipped,
 * or that the cap truncated — and each of those earned a later "unchanged" pointer for code the agent
 * never received.
 *
 * `/clear` in Claude Code keeps the stdio server alive, so a new conversation inherits the process.
 * The SessionStart hook therefore touches the same marker as PreCompact: any fresh context resets.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { responseBodyCharBudget } from "./response-budget.js";

const DEFAULT_TTL_MS = 30 * 60_000;

/**
 * Text every pointer starts with. The response cache must never store a response containing it:
 * a cached pointer would be replayed after a compaction, telling the agent it holds code it lost.
 */
export const SHOWN_SOURCE_POINTER_MARK = "[source unchanged (";
const MAX_ENTRIES = 5_000;

interface ShownEntry {
  hash: string;
  shownAt: number;
}

const ledger = new Map<string, ShownEntry>();
let enabled = false;

function dataDir(): string {
  return process.env["CODESIFT_DATA_DIR"] ?? join(homedir(), ".codesift");
}

export function compactionMarkerPath(): string {
  return join(dataDir(), "compaction.marker");
}

/**
 * Called by the PreCompact and SessionStart hooks: from now on, everything shown earlier counts as
 * unseen. The timestamp is written as the file's CONTENT and read back from it, so both sides of
 * the comparison come from Date.now() — mtime has a different clock and, on some filesystems,
 * a coarser resolution.
 */
export function touchCompactionMarker(): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(compactionMarkerPath(), String(Date.now()));
  } catch {
    // A hook must never fail the host's compaction; the TTL still bounds the damage.
  }
}

function lastCompactionAt(): number {
  const path = compactionMarkerPath();
  try {
    const written = Number(readFileSync(path, "utf-8").trim());
    if (Number.isFinite(written) && written > 0) return written;
    // Unparseable content (hand-touched file): fall back to mtime rather than to "never".
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function ttlMs(): number {
  const raw = Number(process.env["CODESIFT_SHOWN_SOURCE_TTL_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

/**
 * Turn the ledger on for this process. Only the stdio entry point calls this, and
 * CODESIFT_DEDUP_SOURCE=0 keeps it off there too.
 */
export function enableShownSourceLedger(): void {
  enabled = process.env["CODESIFT_DEDUP_SOURCE"] !== "0";
}

export function resetShownSourceLedgerForTesting(on = false): void {
  ledger.clear();
  enabled = on;
}

interface SourceBearing {
  id: string;
  source?: string | undefined;
  file?: string;
  name?: string;
  start_line?: number;
}

/**
 * Ledger key. NOT the raw id: tools hand back the same symbol as `repo:file:name:line` or as
 * `file:name:line` depending on the lookup path (find_and_show vs get_symbols), so keying on the id
 * made a body shown by one tool look unseen to the next.
 */
function ledgerKey(sym: SourceBearing): string {
  return sym.file !== undefined && sym.name !== undefined && sym.start_line !== undefined
    ? `${sym.file}:${sym.name}:${sym.start_line}`
    : sym.id;
}

/** What to render for one symbol, and how to record it once it is known to have been delivered. */
export interface ShownSourceView<T> {
  symbol: T;
  /** Pointer line to print under the header, or "" when the body is sent. */
  note: string;
  /** Record the body as shown. No-op for a pointer view and while the ledger is off. */
  commit(): void;
}

const NOOP = (): void => {};

/**
 * formatResponse prepends a savings line and response hints BEFORE the body, so the body's own
 * budget is smaller than the cap by that much. Conservative: over-reserving only means a block near
 * the edge is resent later, never that a cut block is claimed as delivered.
 */
const HINT_PREFIX_RESERVE_CHARS = 1_000;

/**
 * The symbol to render: `source` replaced by a pointer when this exact body was already delivered
 * in this conversation. Nothing is recorded here — see `commitDelivered`.
 */
export function elideShownSource<T extends SourceBearing>(
  sym: T,
  options?: { force?: boolean },
): ShownSourceView<T> {
  if (!enabled || !sym.source) return { symbol: sym, note: "", commit: NOOP };
  const source = sym.source;
  const hash = createHash("sha1").update(source).digest("hex");
  const key = ledgerKey(sym);
  const prior = ledger.get(key);
  const stillHeld = prior !== undefined
    && prior.hash === hash
    && Date.now() - prior.shownAt < ttlMs()
    && prior.shownAt > lastCompactionAt();

  if (stillHeld && !options?.force) {
    const { source: _omitted, ...rest } = sym;
    const lines = source.split("\n").length;
    return {
      symbol: rest as T,
      note: `  ${SHOWN_SOURCE_POINTER_MARK}${lines} lines, id ${sym.id}) — already shown in this ` +
        "conversation; repeat the call with full_source=true to resend it]",
      commit: NOOP,
    };
  }

  return {
    symbol: sym,
    note: "",
    commit: () => {
      // Map preserves insertion order: delete-then-set moves the entry to the end, so the oldest
      // entry is always first and eviction is a single iterator step.
      ledger.delete(key);
      ledger.set(key, { hash, shownAt: Date.now() });
      if (ledger.size > MAX_ENTRIES) {
        const oldest = ledger.keys().next().value;
        if (oldest !== undefined) ledger.delete(oldest);
      }
    },
  };
}

/**
 * Commit the views whose rendered text lands inside the response budget, in response order.
 *
 * `chars` is the length of that view's rendered block. Blocks past the budget are the ones
 * formatResponse will cut, so they are not recorded — the agent will not have received them.
 * Call only after the full response text has been built successfully.
 */
export function commitDelivered(
  parts: ReadonlyArray<{ view: ShownSourceView<unknown>; chars: number }>,
  budgetChars: number = responseBodyCharBudget() - HINT_PREFIX_RESERVE_CHARS,
): void {
  let used = 0;
  for (const { view, chars } of parts) {
    used += chars;
    if (used > budgetChars) return;
    view.commit();
  }
}
