import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Isolate from the real ~/.codesift/usage.jsonl — the regression under test is the
// package.json require PATH inside the handler (broken after the register-tools ->
// register-tool-groups/ split), not the usage stats read itself.
vi.mock("../../../src/register-tool-groups/deps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/register-tool-groups/deps.js")>();
  return {
    ...actual,
    getUsageStats: vi.fn(async () => ({ total_calls: 0, tools: [], repos: [], hosts: [] })),
    formatUsageReport: vi.fn(() => "no usage"),
  };
});

const { META_TOOL_ENTRIES } = await import("../../../src/register-tool-groups/meta.js");

const here = dirname(fileURLToPath(import.meta.url));
const expectedVersion = JSON.parse(
  readFileSync(join(here, "../../../package.json"), "utf-8"),
) .version as string;

describe("usage_stats version resolution (regression: register-tool-groups split)", () => {
  it("resolves the package.json version instead of throwing MODULE_NOT_FOUND", async () => {
    const entry = META_TOOL_ENTRIES.find((e) => e.definition.name === "usage_stats");
    expect(entry, "usage_stats tool must be registered").toBeDefined();

    // Before the fix this rejects with:
    //   Cannot find module '../package.json' (resolves to src/package.json, which does not exist)
    const result = (await entry!.definition.handler({})) as { version: unknown };

    expect(typeof result.version).toBe("string");
    expect(result.version).toBe(expectedVersion);
  });
});
