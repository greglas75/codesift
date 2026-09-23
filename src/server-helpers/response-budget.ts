/**
 * The response ceiling, in one place.
 *
 * formatResponse cuts anything above it, and the shown-source ledger must know it too: a symbol
 * body that the cap is about to drop was never delivered, so recording it as "shown" would later
 * earn the agent an "unchanged" pointer for code it never received (found in review of 29b8025).
 */
import { CHARS_PER_TOKEN } from "../tools/search-tools/constants.js";

export { CHARS_PER_TOKEN };

/** Default hard cap on one tool response. */
export const MAX_RESPONSE_TOKENS = 30_000;

/**
 * Room the truncation notice needs (counts + saved-path line). The cap is a promise about what the
 * agent receives, so the notice comes out of the budget instead of landing on top of it.
 */
export const TRUNCATION_NOTICE_RESERVE_CHARS = 600;

/**
 * CODESIFT_MAX_RESPONSE_TOKENS lowers (or raises) the ceiling for hosts with a smaller tool-result
 * budget; unparseable values and anything under 500 keep the default.
 */
export function resolveMaxResponseTokens(): number {
  const raw = Number(process.env["CODESIFT_MAX_RESPONSE_TOKENS"]);
  return Number.isFinite(raw) && raw >= 500 ? Math.floor(raw) : MAX_RESPONSE_TOKENS;
}

/** Characters of body text a response may carry before formatResponse starts cutting. */
export function responseBodyCharBudget(): number {
  return Math.floor(resolveMaxResponseTokens() * CHARS_PER_TOKEN) - TRUNCATION_NOTICE_RESERVE_CHARS;
}
