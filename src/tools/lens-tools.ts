import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildLensHtml, type LensData } from "./lens-template.js";

export type { LensData };

/**
 * Generate a self-contained HTML Lens dashboard from pre-computed wiki data.
 *
 * The caller is responsible for assembling LensData (e.g. from generateWiki).
 * This function only handles rendering and file I/O.
 */
export async function generateLens(
  data: LensData,
  outputPath: string,
): Promise<{ path: string }> {
  // Ensure parent directory exists
  await mkdir(join(outputPath, ".."), { recursive: true });

  const html = buildLensHtml(data);
  await writeFile(outputPath, html, "utf-8");

  return { path: outputPath };
}
