import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Multi-Agent Coordinator with Scratchpad
// ---------------------------------------------------------------------------
// Enables complex multi-step code analysis by breaking work into sub-tasks
// with a shared scratchpad directory for cross-step knowledge sharing.
//
// Inspired by Claude Code's "Swarm" coordinator pattern where a planner
// spawns workers with shared state. Here, the scratchpad is a simple
// filesystem-based knowledge store that persists across tool calls.
// ---------------------------------------------------------------------------

export interface ScratchpadEntry {
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export interface AnalysisPlan {
  id: string;
  title: string;
  steps: AnalysisStep[];
  status: "pending" | "in_progress" | "completed" | "failed";
  scratchpad_dir: string;
  created_at: string;
  completed_at?: string;
}

export interface AnalysisStep {
  id: string;
  description: string;
  tool: string;
  args: Record<string, unknown>;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  result_key?: string; // scratchpad key to store result
  depends_on?: string[]; // step IDs that must complete first
  error?: string;
}

// In-memory plan registry
const activePlans = new Map<string, AnalysisPlan>();

function generateId(): string {
  return `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a new analysis plan with a scratchpad directory.
 */
export async function createAnalysisPlan(
  title: string,
  steps: Array<{
    description: string;
    tool: string;
    args: Record<string, unknown>;
    result_key?: string;
    depends_on?: string[];
  }>,
): Promise<AnalysisPlan> {
  const id = generateId();
  const scratchpadDir = join(tmpdir(), "codesift-scratchpad", id);
  await mkdir(scratchpadDir, { recursive: true });

  const plan: AnalysisPlan = {
    id,
    title,
    steps: steps.map((s, i) => ({
      id: `step_${i + 1}`,
      description: s.description,
      tool: s.tool,
      args: s.args,
      status: "pending" as const,
      ...(s.result_key ? { result_key: s.result_key } : {}),
      ...(s.depends_on ? { depends_on: s.depends_on } : {}),
    })),
    status: "pending",
    scratchpad_dir: scratchpadDir,
    created_at: new Date().toISOString(),
  };

  activePlans.set(id, plan);

  // Write plan metadata to scratchpad
  await writeFile(
    join(scratchpadDir, "_plan.json"),
    JSON.stringify(plan, null, 2),
    "utf-8",
  );

  return plan;
}

/**
 * Write a key-value entry to the plan's scratchpad.
 * Scratchpad entries are persisted as individual files.
 */
export async function writeScratchpad(
  planId: string,
  key: string,
  value: string,
): Promise<ScratchpadEntry> {
  const plan = activePlans.get(planId);
  if (!plan) throw new Error(`Plan "${planId}" not found`);

  // Sanitize key for filesystem
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  const now = new Date().toISOString();

  const entry: ScratchpadEntry = {
    key,
    value,
    created_at: now,
    updated_at: now,
  };

  await writeFile(
    join(plan.scratchpad_dir, `${safeKey}.json`),
    JSON.stringify(entry, null, 2),
    "utf-8",
  );

  return entry;
}

/**
 * Read a key from the plan's scratchpad.
 */
export async function readScratchpad(
  planId: string,
  key: string,
): Promise<ScratchpadEntry | null> {
  const plan = activePlans.get(planId);
  if (!plan) throw new Error(`Plan "${planId}" not found`);

  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = join(plan.scratchpad_dir, `${safeKey}.json`);

  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as ScratchpadEntry;
  } catch {
    return null;
  }
}

/**
 * List all entries in the plan's scratchpad.
 */
export async function listScratchpad(
  planId: string,
): Promise<{ entries: Array<{ key: string; size: number; updated_at: string }> }> {
  const plan = activePlans.get(planId);
  if (!plan) throw new Error(`Plan "${planId}" not found`);

  if (!existsSync(plan.scratchpad_dir)) {
    return { entries: [] };
  }

  const files = await readdir(plan.scratchpad_dir);
  const entries: Array<{ key: string; size: number; updated_at: string }> = [];

  for (const file of files) {
    if (file.startsWith("_") || !file.endsWith(".json")) continue;
    try {
      const content = await readFile(join(plan.scratchpad_dir, file), "utf-8");
      const entry = JSON.parse(content) as ScratchpadEntry;
      entries.push({
        key: entry.key,
        size: entry.value.length,
        updated_at: entry.updated_at,
      });
    } catch {
      // Skip corrupt entries
    }
  }

  return { entries };
}

/**
 * Update a step's status in the plan.
 */
export async function updateStepStatus(
  planId: string,
  stepId: string,
  status: AnalysisStep["status"],
  error?: string,
): Promise<AnalysisPlan> {
  const plan = activePlans.get(planId);
  if (!plan) throw new Error(`Plan "${planId}" not found`);

  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`Step "${stepId}" not found in plan "${planId}"`);

  step.status = status;
  if (error) step.error = error;

  // Update plan status
  const allDone = plan.steps.every((s) => s.status === "completed" || s.status === "skipped");
  const anyFailed = plan.steps.some((s) => s.status === "failed");

  if (allDone) {
    plan.status = "completed";
    plan.completed_at = new Date().toISOString();
  } else if (anyFailed) {
    plan.status = "failed";
  } else {
    plan.status = "in_progress";
  }

  // Persist updated plan
  await writeFile(
    join(plan.scratchpad_dir, "_plan.json"),
    JSON.stringify(plan, null, 2),
    "utf-8",
  );

  return plan;
}

/**
 * Get the current state of a plan.
 */
export function getPlan(planId: string): AnalysisPlan | null {
  return activePlans.get(planId) ?? null;
}

/**
 * List all active plans.
 */
export function listPlans(): Array<{
  id: string;
  title: string;
  status: string;
  steps_completed: number;
  steps_total: number;
}> {
  return Array.from(activePlans.values()).map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    steps_completed: p.steps.filter((s) => s.status === "completed").length,
    steps_total: p.steps.length,
  }));
}
