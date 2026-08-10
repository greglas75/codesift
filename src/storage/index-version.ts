import type { CodeIndex } from "../types.js";
import { classifyStorageError } from "./sqlite-index-store.js";

/** Result of a version-aware index load. */
export type IndexOrStaleResult =
  | { status: "ok"; index: CodeIndex }
  | {
      status: "unreadable";
      reason: "storage_error";
      code: string;
      message: string;
    }
  | {
      status: "stale";
      reason: "extractor_version_mismatch";
      language: string;
      expected_version: string;
      actual_version: string;
      mismatch_detail?: string;
    };

export type ExtractorVersionMismatchRow = {
  language: string;
  expected: string;
  actual: string;
};

/** Only the fields required to validate extractor versions. */
export type ExtractorVersionCheckable = Pick<CodeIndex, "extractor_version" | "files">;

/**
 * Return every language whose stored extractor version differs from the bundled version.
 * Newly added extractors are tolerated until the index actually contains that language.
 */
export function collectExtractorVersionMismatches(
  index: ExtractorVersionCheckable,
  currentVersions: Record<string, string>,
): ExtractorVersionMismatchRow[] {
  const stored = index.extractor_version ?? {};
  const storedKeys = Object.keys(stored);
  const indexedLanguages = new Set<string>();
  for (const file of index.files) indexedLanguages.add(file.language);

  const out: ExtractorVersionMismatchRow[] = [];
  if (index.files.length === 0 && storedKeys.length === 0) {
    const langKeys = Object.keys(currentVersions);
    if (langKeys.length === 0) return [];
    out.push({ language: "*", expected: "any", actual: "empty_index" });
    return out;
  }

  for (const lang of Object.keys(currentVersions)) {
    const expected = currentVersions[lang];
    const actual = stored[lang];
    if (expected === actual) continue;
    if (actual === undefined && !indexedLanguages.has(lang)) continue;
    out.push({
      language: lang,
      expected: expected ?? "unknown",
      actual: actual ?? "missing",
    });
  }
  return out;
}

export function isExtractorVersionCurrent(
  index: ExtractorVersionCheckable,
  currentVersions: Record<string, string>,
): boolean {
  if (!index.extractor_version) return false;
  return collectExtractorVersionMismatches(index, currentVersions).length === 0;
}

type IndexReader = (indexPath: string) => Promise<CodeIndex | null>;

/**
 * Load an index and turn extractor drift or storage failures into structured results.
 * The facade injects its backend-agnostic reader to keep this module independent of it.
 */
export async function loadVersionAwareIndex(
  indexPath: string,
  currentVersions: Record<string, string>,
  readIndex: IndexReader,
): Promise<IndexOrStaleResult | null> {
  let parsed: CodeIndex | null;
  try {
    parsed = await readIndex(indexPath);
  } catch (err) {
    const code = classifyStorageError(err);
    if (code === null) throw err;
    return {
      status: "unreadable",
      reason: "storage_error",
      code,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    if (!parsed) return null;
    const mismatches = collectExtractorVersionMismatches(parsed, currentVersions);
    if (mismatches.length > 0) {
      const first = mismatches[0]!;
      return {
        status: "stale",
        reason: "extractor_version_mismatch",
        language: first.language,
        expected_version: first.expected,
        actual_version: first.actual,
        ...(mismatches.length > 1
          ? {
              mismatch_detail: mismatches
                .map((m) => `${m.language}: expected ${m.expected}, got ${m.actual}`)
                .join("; "),
            }
          : {}),
      };
    }
    return { status: "ok", index: parsed };
  } catch {
    return null;
  }
}
