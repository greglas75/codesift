import { describe, it, expect } from "vitest";
import { buildReport } from "../../scripts/journal-cadence-report.js";
import type { GitCommit } from "../../src/tools/journal-git-client.js";

function commit(subject: string): GitCommit {
  return {
    sha: "abcdef1234567890",
    date: "2026-04-21T12:00:00+00:00",
    authorName: "Test",
    subject,
    parentShas: [],
    refs: [],
  };
}

describe("cadence report — buildReport", () => {
  it("counts journal append commits referencing the journal path or 'journal append' phrase", () => {
    const commits = [
      commit("journal append: week 16"),
      commit("update .codesift/wiki/journal/overview.md"),
      commit("unrelated feature work"),
    ];
    const r = buildReport(commits, 30);
    expect(r.appends).toBe(2);
  });

  it("counts My-notes edits via subject pattern", () => {
    const commits = [
      commit("My notes: observations on week 14"),
      commit("notes-edit to phase-summary"),
      commit("refactor something"),
    ];
    const r = buildReport(commits, 30);
    expect(r.notes_edits).toBe(2);
  });

  it("returns JSON shape with 4-or-2 threshold (passes when 4 appends)", () => {
    const commits = [
      ...Array.from({ length: 4 }, () => commit("journal append: batch")),
      commit("other"),
    ];
    const r = buildReport(commits, 30);
    expect(r).toMatchObject({
      since_days: 30,
      appends: 4,
      notes_edits: 0,
      passes_threshold: true,
    });
  });

  it("4-or-2 threshold passes when 2 notes edits", () => {
    const commits = [
      commit("My notes: reflection"),
      commit("My notes: another"),
    ];
    const r = buildReport(commits, 30);
    expect(r.passes_threshold).toBe(true);
  });

  it("threshold fails when below both cutoffs", () => {
    const r = buildReport([commit("journal append: one")], 30);
    expect(r.passes_threshold).toBe(false);
  });
});
