// ---------------------------------------------------------------------------
// CLI handlers for wiki-generate and wiki-lint
// ---------------------------------------------------------------------------

import type { Flags } from "./args.js";
import { getFlag, getBoolFlag } from "./args.js";

export async function handleWikiGenerate(args: string[], flags: Flags): Promise<void> {
  const repo = args[0] ?? "";
  const focus = getFlag(flags, "focus") ?? undefined;
  const outputDir = getFlag(flags, "output") ?? undefined;
  const noLens = getBoolFlag(flags, "no-lens");

  const { generateWiki } = await import("../tools/wiki-tools.js");
  const wikiOptions: { focus?: string; output_dir?: string } = {};
  if (focus !== undefined) wikiOptions.focus = focus;
  if (outputDir !== undefined) wikiOptions.output_dir = outputDir;
  const result = await generateWiki(repo, wikiOptions);

  // Lens generation requires pre-assembled LensData from the wiki orchestrator.
  // When --no-lens is set, skip entirely. When lens is requested, it will be
  // wired up once the wiki orchestrator exposes buildLensData.
  if (!noLens) {
    // Lens data plumbing not yet available via generateWiki result;
    // no-op until wiki-tools exposes LensData in WikiResult.
    void (await import("../tools/lens-tools.js"));
  }

  const lines = [
    `Wiki generated: ${result.pages} pages`,
    `  Communities: ${result.communities}`,
    `  Hubs: ${result.hubs}`,
    `  Surprises: ${result.surprises}`,
    result.degraded ? "  \u26a0 Degraded: some analyses timed out" : "",
    `  Output: ${result.wiki_dir}`,
  ].filter(Boolean);

  process.stdout.write(lines.join("\n") + "\n");
}

export async function handleWikiLint(args: string[], _flags: Flags): Promise<void> {
  const wikiDir = args[0] ?? "";
  const { lintWiki } = await import("../tools/wiki-lint.js");
  const result = await lintWiki(wikiDir);

  if (result.issues.length === 0 && result.warnings.length === 0) {
    process.stdout.write("Wiki lint: no issues found\n");
  } else {
    for (const issue of result.issues) {
      process.stderr.write(`ERROR: ${(issue as { message: string }).message}\n`);
    }
    for (const warning of result.warnings) {
      process.stderr.write(`WARN: ${(warning as { message: string }).message}\n`);
    }
    process.exitCode = result.issues.length > 0 ? 1 : 0;
  }
}
