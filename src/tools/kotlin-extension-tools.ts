import { getCodeIndex } from "./index-tools.js";

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
  const index = await getCodeIndex(repo);
  if (!index) {
    throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  }

  const pattern = `${receiverType}.`;
  const extensions: ExtensionFunctionResult["extensions"] = [];
  for (const sym of index.symbols) {
    if (sym.kind !== "function") continue;
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
