import { findRepoSymbols, getIndexSummary } from "./index-tools.js";

export interface ExtensionFunctionResult {
  receiver_type: string;
  extensions: Array<{
    name: string;
    file: string;
    start_line: number;
    signature?: string;
    docstring?: string;
  }>;
  total: number;
}

/** Find all extension functions defined for a given receiver type. */
export async function findExtensionFunctions(
  repo: string,
  receiverType: string,
  options?: { file_pattern?: string },
): Promise<ExtensionFunctionResult> {
  const summary = await getIndexSummary(repo);
  if (!summary) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const pattern = `${receiverType}.`;
  const extensions: ExtensionFunctionResult["extensions"] = [];
  // Extensions are functions identified by their signature, so one kind-keyed read without
  // `source` replaces the materialised index.
  const functions = await findRepoSymbols(
    repo,
    { kind: "function", withSource: false },
    { skipFreshness: true },
  );
  for (const sym of functions) {
    if (!sym.signature) continue;
    if (options?.file_pattern && !sym.file.includes(options.file_pattern)) continue;

    const sig = sym.signature.replace(/^suspend\s+/, "");
    if (sig.startsWith(pattern) || sig.startsWith(`${receiverType}<`)) {
      extensions.push({
        name: sym.name,
        file: sym.file,
        start_line: sym.start_line,
        ...(sym.signature ? { signature: sym.signature } : {}),
        ...(sym.docstring ? { docstring: sym.docstring } : {}),
      });
    }
  }

  extensions.sort((a, b) => a.file.localeCompare(b.file) || a.start_line - b.start_line);
  return { receiver_type: receiverType, extensions, total: extensions.length };
}
