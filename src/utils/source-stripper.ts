/**
 * Stable facade for character-level source stripping.
 * The implementation lives in focused state handlers under ./source-stripper/.
 * This is a heuristic lexer: JSX text and tagged-template `${...}` grammar are
 * intentionally limited, and slash classification follows token context.
 */
import { runStripMachine } from "./source-stripper/machine.js";

export function stripCommentsAndStrings(source: string): string {
  return runStripMachine(source);
}
