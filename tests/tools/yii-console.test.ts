/**
 * Tests for analyzeYiiConsoleCommands (N4).
 *
 * Fixture has two console controllers:
 *   - SyncController:  actionRun (clean: try/catch + ExitCode + typed args)
 *                      actionSweep (variadic, clean)
 *   - RiskyController: actionExportAll (4 flags) + actionSafeProcess (0 flags)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join, resolve } from "node:path";
import { indexFolder } from "../../src/tools/index-tools.js";
import { analyzeYiiConsoleCommands } from "../../src/tools/yii-console-tools.js";

const FIXTURE_ROOT = resolve(
  join(__dirname, "..", "fixtures", "php-yii-console"),
);
const REPO = "local/php-yii-console";

describe("analyzeYiiConsoleCommands", () => {
  beforeAll(async () => {
    await indexFolder(FIXTURE_ROOT);
  });

  it("returns structured per-controller summary", async () => {
    const r = await analyzeYiiConsoleCommands(REPO);
    expect(r.repo).toBe(REPO);
    expect(r.total_controllers).toBe(2);
    const cliIds = r.controllers.map((c) => c.cli_id).sort();
    expect(cliIds).toEqual(["risky", "sync"]);
  });

  it("derives CLI ids from PascalCase class + actionFooBar method", async () => {
    const r = await analyzeYiiConsoleCommands(REPO);
    const sync = r.controllers.find((c) => c.cli_id === "sync");
    expect(sync).toBeDefined();
    const run = sync!.actions.find((a) => a.name === "actionRun");
    expect(run).toBeDefined();
    expect(run!.cli_id).toBe("run");

    const risky = r.controllers.find((c) => c.cli_id === "risky");
    const exportAll = risky!.actions.find((a) => a.name === "actionExportAll");
    expect(exportAll!.cli_id).toBe("export-all");
  });

  it("parses typed action arguments with defaults", async () => {
    const r = await analyzeYiiConsoleCommands(REPO);
    const sync = r.controllers.find((c) => c.cli_id === "sync");
    const run = sync!.actions.find((a) => a.name === "actionRun");
    expect(run!.arguments).toHaveLength(2);
    expect(run!.arguments[0]).toEqual({
      name: "repo",
      type: "string",
      default: null,
      required: true,
    });
    expect(run!.arguments[1]).toEqual({
      name: "limit",
      type: "int",
      default: "100",
      required: false,
    });
  });

  it("flags variadic actions", async () => {
    const r = await analyzeYiiConsoleCommands(REPO);
    const sync = r.controllers.find((c) => c.cli_id === "sync");
    const sweep = sync!.actions.find((a) => a.name === "actionSweep");
    expect(sweep!.variadic).toBe(true);
  });

  it("captures docstring on action methods", async () => {
    const r = await analyzeYiiConsoleCommands(REPO);
    const sync = r.controllers.find((c) => c.cli_id === "sync");
    const run = sync!.actions.find((a) => a.name === "actionRun");
    expect(run!.docstring).toContain("one-shot sync");
  });

  it("flags actionExportAll with 4 risk flags", async () => {
    const r = await analyzeYiiConsoleCommands(REPO);
    const risky = r.controllers.find((c) => c.cli_id === "risky");
    const exportAll = risky!.actions.find((a) => a.name === "actionExportAll");
    expect(exportAll!.flags).toContain("exits-without-return-status");
    expect(exportAll!.flags).toContain("has-unbounded-all");
    expect(exportAll!.flags).toContain("has-no-error-handling");
    expect(exportAll!.flags).toContain("uses-output-via-echo");
  });

  it("does NOT flag actionSafeProcess (has try/catch + ExitCode)", async () => {
    const r = await analyzeYiiConsoleCommands(REPO);
    const risky = r.controllers.find((c) => c.cli_id === "risky");
    const safe = risky!.actions.find((a) => a.name === "actionSafeProcess");
    expect(safe!.flags.length).toBe(0);
  });

  it("populates high_risk_actions cross-controller summary", async () => {
    const r = await analyzeYiiConsoleCommands(REPO);
    expect(r.high_risk_actions.length).toBeGreaterThanOrEqual(1);
    expect(r.high_risk_actions[0]!.action).toBe("actionExportAll");
    expect(r.high_risk_actions[0]!.cli_id).toBe("risky/export-all");
  });

  it("respects controller_id filter", async () => {
    const r = await analyzeYiiConsoleCommands(REPO, { controller_id: "sync" });
    expect(r.controllers.length).toBe(1);
    expect(r.controllers[0]!.cli_id).toBe("sync");
  });

  it("counts total_actions across all controllers", async () => {
    const r = await analyzeYiiConsoleCommands(REPO);
    // SyncController: actionRun + actionSweep = 2
    // RiskyController: actionExportAll + actionSafeProcess = 2
    expect(r.total_actions).toBe(4);
  });
});
