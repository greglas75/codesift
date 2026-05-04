/**
 * Tool-layer utilities — stateless converter/formatter helpers shared across
 * MCP tool wrappers in `src/tools/*.ts`.
 *
 * Conventions:
 *   - Pure functions only (no I/O, no global state).
 *   - Each helper is independently testable.
 *   - First occupant: staleToMcpError — converts a "stale index" discriminated
 *     union from loadIndexOrStale into the standard MCP `{ isError: true }`
 *     error envelope so MCP clients handle stale-index the same way they handle
 *     any other tool error.
 */

interface StaleIndexResult {
  reason: string;
  expected_version: string;
  actual_version: string;
  /** Optional language identifier (e.g., "typescript"). When present, the
   *  rendered error text names it explicitly. Older callers that omit this
   *  still get a sensible message. */
  language?: string;
}

interface McpErrorEnvelope {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
}

/** Convert a stale-index result to the standard MCP isError envelope.
 *
 * The internal TypeScript contract uses a discriminated union
 * `{ status: "ok" | "stale", ... }` for type-safe handling at call sites; the
 * wire format is the standard MCP error envelope so existing client code paths
 * handle it without changes. */
export function staleToMcpError(stale: StaleIndexResult): McpErrorEnvelope {
  const langPrefix = stale.language ? `${stale.language} ` : "";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Index stale: ${stale.reason} (${langPrefix}expected ${stale.expected_version}, got ${stale.actual_version}). Run index_folder to refresh.`,
      },
    ],
  };
}
