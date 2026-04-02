import { describe, it, expect } from "vitest";
import {
  createAnalysisPlan,
  writeScratchpad,
  readScratchpad,
  listScratchpad,
  updateStepStatus,
  getPlan,
  listPlans,
} from "../../src/tools/coordinator-tools.js";

describe("coordinator-tools", () => {
  it("creates a plan with scratchpad directory", async () => {
    const plan = await createAnalysisPlan("Test analysis", [
      { description: "Search symbols", tool: "search_symbols", args: { repo: "test", query: "foo" }, result_key: "symbols" },
      { description: "Find refs", tool: "find_references", args: { repo: "test", symbol_name: "foo" }, depends_on: ["step_1"] },
    ]);

    expect(plan.id).toMatch(/^plan_/);
    expect(plan.title).toBe("Test analysis");
    expect(plan.steps).toHaveLength(2);
    expect(plan.status).toBe("pending");
    expect(plan.scratchpad_dir).toBeDefined();
  });

  it("writes and reads scratchpad entries", async () => {
    const plan = await createAnalysisPlan("Scratchpad test", [
      { description: "step1", tool: "test", args: {} },
    ]);

    await writeScratchpad(plan.id, "key1", "value1");
    const entry = await readScratchpad(plan.id, "key1");

    expect(entry).not.toBeNull();
    expect(entry!.key).toBe("key1");
    expect(entry!.value).toBe("value1");
  });

  it("lists scratchpad entries", async () => {
    const plan = await createAnalysisPlan("List test", [
      { description: "step1", tool: "test", args: {} },
    ]);

    await writeScratchpad(plan.id, "a", "hello");
    await writeScratchpad(plan.id, "b", "world");

    const list = await listScratchpad(plan.id);
    expect(list.entries).toHaveLength(2);
    expect(list.entries.map((e) => e.key).sort()).toEqual(["a", "b"]);
  });

  it("updates step and plan status", async () => {
    const plan = await createAnalysisPlan("Status test", [
      { description: "step1", tool: "test", args: {} },
      { description: "step2", tool: "test", args: {} },
    ]);

    await updateStepStatus(plan.id, "step_1", "completed");
    let updated = getPlan(plan.id)!;
    expect(updated.steps[0]!.status).toBe("completed");
    expect(updated.status).toBe("in_progress");

    await updateStepStatus(plan.id, "step_2", "completed");
    updated = getPlan(plan.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.completed_at).toBeDefined();
  });

  it("lists all active plans", async () => {
    const before = listPlans().length;
    await createAnalysisPlan("List plans test", [
      { description: "step1", tool: "test", args: {} },
    ]);
    expect(listPlans().length).toBe(before + 1);
  });

  it("returns null for missing scratchpad key", async () => {
    const plan = await createAnalysisPlan("Missing key", [
      { description: "step1", tool: "test", args: {} },
    ]);
    const result = await readScratchpad(plan.id, "nonexistent");
    expect(result).toBeNull();
  });
});
