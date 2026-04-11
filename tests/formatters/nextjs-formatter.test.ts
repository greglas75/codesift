import { describe, it, expect } from "vitest";
import { formatNextjsComponents } from "../../src/formatters.js";
import type { NextjsComponentsResult } from "../../src/tools/nextjs-component-tools.js";
import { getToolDefinitions } from "../../src/register-tools.js";

describe("formatNextjsComponents", () => {
  it("renders counts and violations", () => {
    const result: NextjsComponentsResult = {
      files: [
        {
          path: "app/page.tsx",
          classification: "server",
          directive: null,
          signals: { hooks: [], event_handlers: [], browser_globals: [], dynamic_ssr_false: false },
          violations: [],
        },
        {
          path: "app/components/UnnecessaryClient.tsx",
          classification: "client_explicit",
          directive: "use client",
          signals: { hooks: [], event_handlers: [], browser_globals: [], dynamic_ssr_false: false },
          violations: ["unnecessary_use_client"],
        },
      ],
      counts: {
        total: 2,
        server: 1,
        client_explicit: 1,
        client_inferred: 0,
        ambiguous: 0,
        unnecessary_use_client: 1,
      },
      parse_failures: [],
      scan_errors: [],
      truncated: false,
      workspaces_scanned: ["/tmp/fake"],
      limitations: ["no transitive client boundary detection via barrel files"],
    };

    const out = formatNextjsComponents(result);
    expect(out).toContain("Total: 2");
    expect(out).toContain("Server: 1");
    expect(out).toContain("Client (explicit): 1");
    expect(out).toContain("unnecessary_use_client");
  });
});

describe("analyze_nextjs_components tool registration", () => {
  it("is included in TOOL_DEFINITIONS with category 'analysis'", () => {
    const defs = getToolDefinitions();
    const entry = defs.find((t) => t.name === "analyze_nextjs_components");
    expect(entry).toBeDefined();
    expect(entry!.category).toBe("analysis");
  });
});
