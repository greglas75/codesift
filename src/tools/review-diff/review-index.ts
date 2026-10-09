import type { IndexSummary } from "../../storage/sqlite-index-store.js";
import type { CodeIndex, CodeSymbol, FileEntry } from "../../types.js";
import { isTestFile } from "../../utils/test-file.js";
import { findRepoSymbols, findRepoSymbolsInFiles } from "../index-tools.js";

/**
 * What review_diff's checks read from the index: the file list and the root, plus two narrow symbol
 * reads. It used to load the whole index for those two reads (ADR-004 stage 2) — 13 s and +2.4 GB on
 * a 450k-symbol repo, before any check ran.
 */
export interface ReviewIndex {
  repo: string;
  root: string;
  files: FileEntry[];
  /** The symbols of one file, in index order, without source. */
  symbolsInFile(file: string): Promise<CodeSymbol[]>;
  /** Whether any symbol in a test file has a non-empty source containing `text`. */
  testSourceMentions(text: string): Promise<boolean>;
}

/** Over a loaded index — what the checks' unit tests hand them. */
export function reviewIndexFromCodeIndex(index: CodeIndex): ReviewIndex {
  return {
    repo: index.repo,
    root: index.root,
    files: index.files,
    symbolsInFile: async (file) => index.symbols.filter((s) => s.file === file),
    testSourceMentions: async (text) =>
      index.symbols.some((s) => isTestFile(s.file) && !!s.source && s.source.includes(text)),
  };
}

/** Over the summary, with each symbol read asked of the store. */
export function reviewIndexFromSummary(summary: IndexSummary): ReviewIndex {
  const repo = summary.repo;
  return {
    repo,
    root: summary.root,
    files: summary.files,
    symbolsInFile: (file) => findRepoSymbolsInFiles(repo, [file], { withSource: false, skipFreshness: true }),
    testSourceMentions: async (text) => {
      // The store tests the literal; only the file needs checking here. An empty needle matches any
      // source, empty ones included, so that case reads source to keep "non-empty" exact.
      const hits = await findRepoSymbols(
        repo,
        { sourceContainsAny: [text], withSource: text === "" },
        { skipFreshness: true },
      );
      return hits.some((s) => isTestFile(s.file) && (text !== "" || !!s.source));
    },
  };
}
