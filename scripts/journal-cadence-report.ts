#!/usr/bin/env node
// Cadence telemetry: counts journal appends + My-notes edits over a
// window, flags whether the project is meeting the S3 4-or-2 gate.
import { gitLog, type GitCommit } from "../src/tools/journal-git-client.js";

export interface CadenceReport {
  since_days: number;
  appends: number;
  notes_edits: number;
  passes_threshold: boolean;
}

const JOURNAL_PATH = ".codesift/wiki/journal/";

export function buildReport(commits: GitCommit[], sinceDays: number): CadenceReport {
  let appends = 0;
  let notesEdits = 0;
  for (const c of commits) {
    if (c.subject.includes(JOURNAL_PATH) || /journal[- ]append/i.test(c.subject)) appends++;
    if (/my notes|notes[- ]edit/i.test(c.subject)) notesEdits++;
  }
  // S3 gate: ≥4 appends OR ≥2 notes edits in the window
  const passes_threshold = appends >= 4 || notesEdits >= 2;
  return { since_days: sinceDays, appends, notes_edits: notesEdits, passes_threshold };
}

export async function runCadenceReport(sinceDays: number): Promise<CadenceReport> {
  const commits = gitLog({ since: `${sinceDays} days ago` });
  return buildReport(commits, sinceDays);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const sinceIdx = argv.indexOf("--since");
  const sinceDays = sinceIdx >= 0 ? Number(argv[sinceIdx + 1]) : 30;
  runCadenceReport(sinceDays).then((r) => {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    process.exit(0);
  }).catch((err) => { console.error(err); process.exit(1); });
}
