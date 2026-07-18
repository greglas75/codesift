import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  memoryCandidateExtract,
  optimizationCandidates,
  retrosAnalyze,
  retrosList,
  usageHotspots,
  usageTraceSession,
} from "../../src/tools/insights-tools.js";

let tmp: string | null = null;

async function makeTmp(): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), "codesift-insights-test-"));
  return tmp;
}

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  tmp = null;
  delete process.env["CODESIFT_DATA_DIR"];
});

describe("PopeInsights CodeSift tools", () => {
  it("detects usage hotspots and traces sessions", async () => {
    const dir = await makeTmp();
    process.env["CODESIFT_DATA_DIR"] = dir;
    await writeFile(join(dir, "usage.jsonl"), [
      JSON.stringify({ ts: 1700000000000, tool: "search_text", repo: "owner/repo", args_summary: { query: "auth" }, elapsed_ms: 1500, result_tokens: 2200, result_chunks: 4, session_id: "s1" }),
      JSON.stringify({ ts: 1700000001000, tool: "search_text", repo: "owner/repo", args_summary: { query: "auth" }, elapsed_ms: 1600, result_tokens: 2400, result_chunks: 4, session_id: "s1" }),
      JSON.stringify({ ts: 1700000002000, tool: "search_text", repo: "owner/repo", args_summary: { query: "auth" }, elapsed_ms: 1700, result_tokens: 2300, result_chunks: 4, session_id: "s1" }),
    ].join("\n"));

    const hotspots = await usageHotspots({ repo: "owner/repo" });
    expect(hotspots.slow_tools[0]?.tool).toBe("search_text");
    expect(hotspots.repeated_calls.length).toBeGreaterThan(0);

    const trace = await usageTraceSession({ session_id: "s1" });
    expect(trace.calls).toHaveLength(3);
  });

  it("loads and analyzes Zuvo retros", async () => {
    const dir = await makeTmp();
    const zuvo = join(dir, ".zuvo");
    await mkdir(zuvo);
    await writeFile(join(zuvo, "retros.log"), [
      "# v2 DATE SKILL PROJECT CODE_TYPE FRICTION_CATEGORY MISSING_TEMPLATE CONTEXT_GAP TURNS_WASTED TOOL_CALLS FILES_READ FILES_MODIFIED BRANCH SHA7 BLIND_AUDIT ADVERSARIAL CODESIFT ROUTING_STATUS",
      "2026-05-04T10:41:12Z\treview\tcodesift-mcp\tMIXED\tcontext-missing\tmissing-rule\tnone\t2\t25\t8\t0\tmain\tf95aeed\tnot_run\tblocked\tunavailable\tok",
      "2026-05-04T10:42:12Z\treview\tcodesift-mcp\tMIXED\tcontext-missing\tmissing-rule\tnone\t3\t30\t9\t1\tmain\tf95aeed\tnot_run\tblocked\tunavailable\tok",
    ].join("\n"));
    await writeFile(join(zuvo, "retros.md"), `<!-- RETRO -->
## [2026-05-04T10:43:12Z] [review] [codesift-mcp] [src/foo.ts]
### Friction
- **Most turns:** 4 turns.
### Session Cost
- **Files read:** 7
- **Files modified:** 1
- **Tool calls:** 19 total
### Change Proposals (ranked by impact, up to 5)
**1.** FILE: AGENTS.md | SECTION: Context
CONTENT:
Add reusable context.
RATIONALE: Saves time.
`);

    const list = await retrosList({ zuvo_dir: zuvo });
    expect(list.total).toBe(3);

    const analysis = await retrosAnalyze({ zuvo_dir: zuvo });
    expect(analysis.by_friction[0]?.friction_category).toBe("context-missing");

    const memory = await memoryCandidateExtract({ zuvo_dir: zuvo });
    expect(memory.candidates[0]?.kind).toBe("memory_candidate");

    const candidates = await optimizationCandidates({ zuvo_dir: zuvo });
    expect(candidates.candidates.some((candidate) => candidate.kind === "skill_gap")).toBe(true);
  });
});
