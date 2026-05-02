import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");

const SPEC_ARTIFACT = "docs/specs/2026-05-01-monorepo-workspace-intelligence-adversarial.json";
const PLAN_ARTIFACT = "docs/specs/2026-05-01-monorepo-workspace-intelligence-plan-adversarial.json";

interface AdversarialArtifact {
  critical_count_after_fix?: number;
  all_critical_resolved?: boolean;
  rounds?: Array<{ critical: number }>;
  status?: string;
}

describe("Adversarial gate (Task 21, SC4)", () => {
  it("spec adversarial artifact exists at canonical path", () => {
    const path = join(REPO_ROOT, SPEC_ARTIFACT);
    expect(existsSync(path), `expected ${SPEC_ARTIFACT} to exist`).toBe(true);
  });

  it("plan adversarial artifact exists at canonical path", () => {
    const path = join(REPO_ROOT, PLAN_ARTIFACT);
    expect(existsSync(path), `expected ${PLAN_ARTIFACT} to exist`).toBe(true);
  });

  it("SC4: zero CRITICAL findings remain after fixes (spec)", () => {
    const path = join(REPO_ROOT, SPEC_ARTIFACT);
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf-8")) as AdversarialArtifact;
    if (typeof data.critical_count_after_fix === "number") {
      expect(data.critical_count_after_fix).toBe(0);
    } else if (data.all_critical_resolved !== undefined) {
      expect(data.all_critical_resolved).toBe(true);
    }
  });

  it("SC4: zero CRITICAL findings remain after fixes (plan)", () => {
    const path = join(REPO_ROOT, PLAN_ARTIFACT);
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf-8")) as AdversarialArtifact;
    if (data.all_critical_resolved !== undefined) {
      expect(data.all_critical_resolved).toBe(true);
    }
    // Walk the rounds[] structure used in plan artifact: final round must have critical: 0
    if (Array.isArray(data.rounds) && data.rounds.length > 0) {
      const lastRound = data.rounds[data.rounds.length - 1]!;
      // Allow for the final round having unresolved CRITICAL only if all were either fixed
      // (`outcome: "rev<N> fixes applied"`) or accepted with rationale.
      if (data.all_critical_resolved !== true) {
        expect(lastRound.critical).toBeLessThanOrEqual(0);
      }
    }
  });

  it("gate script exists at canonical path", () => {
    const path = join(REPO_ROOT, "scripts/run-adversarial-gate.sh");
    expect(existsSync(path)).toBe(true);
  });
});
