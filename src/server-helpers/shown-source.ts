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
 */
import { createHash } from "node:crypto";
import { statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

/** Called by the PreCompact hook: from now on, everything shown earlier counts as unseen. */
export function touchCompactionMarker(): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(compactionMarkerPath(), String(Date.now()));
  } catch {
    // A hook must never fail the host's compaction; the TTL still bounds the damage.
  }
}

function lastCompactionAt(): number {
  try {
    return statSync(compactionMarkerPath()).mtimeMs;
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
}

/**
 * The symbol to render, with `source` removed when this exact body was already shown in this
 * conversation — plus the note that says so. Records the body as shown otherwise.
 */
export function elideShownSource<T extends SourceBearing>(
  sym: T,
  options?: { force?: boolean },
): { symbol: T; note: string } {
  if (!enabled || !sym.source) return { symbol: sym, note: "" };
  const hash = createHash("sha1").update(sym.source).digest("hex");
  const now = Date.now();
  const prior = ledger.get(sym.id);
  const stillHeld = prior !== undefined
    && prior.hash === hash
    && now - prior.shownAt < ttlMs()
    && prior.shownAt > lastCompactionAt();

  if (stillHeld && !options?.force) {
    const { source: _omitted, ...rest } = sym;
    const lines = sym.source.split("\n").length;
    return {
      symbol: rest as T,
      note: `  ${SHOWN_SOURCE_POINTER_MARK}${lines} lines) — already shown in this conversation; ` +
        `get_symbol(symbol_id="${sym.id}", full_source=true) resends it]`,
    };
  }

  // Map preserves insertion order: delete-then-set moves the entry to the end, so the oldest
  // entry is always first and eviction is a single iterator step.
  ledger.delete(sym.id);
  ledger.set(sym.id, { hash, shownAt: now });
  if (ledger.size > MAX_ENTRIES) {
    const oldest = ledger.keys().next().value;
    if (oldest !== undefined) ledger.delete(oldest);
  }
  return { symbol: sym, note: "" };
}
