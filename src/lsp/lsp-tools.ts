import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getLspManager } from "./lsp-manager.js";
import { getCodeIndex, indexFile } from "../tools/index-tools.js";
import { withTimeout } from "../retrieval/retrieval-utils.js";
import type { CodeIndex, Reference } from "../types.js";

const LSP_TIMEOUT_MS = 10_000;

/** Map file extension to LSP language ID. */
export function detectLanguage(filePath: string): string | null {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".py": "python", ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php",
    ".kt": "kotlin", ".kts": "kotlin",
  };
  return map[ext] ?? null;
}

/** Resolve symbol name to file position. Uses provided params or searches index. */
export async function resolveSymbolPosition(
  index: CodeIndex,
  symbolName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<{ filePath: string; line: number; character: number } | null> {
  if (filePath && line !== undefined) {
    return { filePath, line, character: character ?? 0 };
  }
  const sym = index.symbols.find((s) => s.name === symbolName);
  if (!sym) return null;
  return { filePath: sym.file, line: sym.start_line - 1, character: 0 };
}

/**
 * Go to the definition of a symbol.
 * LSP when available, falls back to index search.
 */
export async function goToDefinition(
  repo: string,
  symbolName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<{ file: string; line: number; character: number; preview?: string; via: "lsp" | "index"; hint?: string } | null> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const pos = await resolveSymbolPosition(index, symbolName, filePath, line, character);
  if (!pos) return null;

  const language = detectLanguage(pos.filePath);
  if (!language) return null;

  const manager = getLspManager();
  const client = await manager.getClient(index.root, language);

  if (client) {
    try {
      const fileUri = pathToFileURL(join(index.root, pos.filePath)).href;
      const content = await readFile(join(index.root, pos.filePath), "utf-8");
      await client.openFile(fileUri, content, language);

      const result = await withTimeout(
        client.request<unknown>("textDocument/definition", {
          textDocument: { uri: fileUri },
          position: { line: pos.line, character: pos.character },
        }),
        LSP_TIMEOUT_MS,
        "LSP definition",
      );

      const loc = Array.isArray(result) ? result[0] : result;
      if (loc && typeof loc === "object") {
        const l = loc as { uri?: string; targetUri?: string; range?: { start: { line: number; character: number } }; targetRange?: { start: { line: number; character: number } } };
        const uri = l.targetUri ?? l.uri ?? "";
        const range = l.targetRange ?? l.range;
        const rootUri = pathToFileURL(index.root).href;
        const defFile = uri.replace(rootUri + "/", "").replace(rootUri, "");
        const defLine = (range?.start.line ?? 0) + 1;

        let preview: string | undefined;
        try {
          const defContent = await readFile(join(index.root, defFile), "utf-8");
          const lines = defContent.split("\n");
          const start = Math.max(0, defLine - 2);
          const end = Math.min(lines.length, defLine + 3);
          preview = lines.slice(start, end).join("\n");
        } catch { /* ignore */ }

        return { file: defFile, line: defLine, character: range?.start.character ?? 0, via: "lsp", ...(preview !== undefined ? { preview } : {}) };
      }
    } catch {
      // LSP failed — fall through to index fallback
    }
  }

  // Fallback: search index
  const sym = index.symbols.find((s) => s.name === symbolName);
  if (!sym) return null;

  const hint = language ? manager.getServerName(language) : null;
  return {
    file: sym.file,
    line: sym.start_line,
    character: 0,
    via: "index",
    ...(sym.source ? { preview: sym.source.slice(0, 300) } : {}),
    ...(hint ? { hint: `Install ${hint} for precise go-to-definition` } : {}),
  };
}

/**
 * Get type information for a symbol via LSP textDocument/hover.
 * Returns type signature + documentation, or hint when LSP is unavailable.
 */
export async function getTypeInfo(
  repo: string,
  symbolName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<{ type: string; documentation?: string; via: "lsp" } | { via: "unavailable"; hint: string }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const pos = await resolveSymbolPosition(index, symbolName, filePath, line, character);
  if (!pos) return { via: "unavailable", hint: "Symbol not found in index" };

  const language = detectLanguage(pos.filePath);
  if (!language) return { via: "unavailable", hint: "Unsupported language for LSP" };

  const manager = getLspManager();
  const client = await manager.getClient(index.root, language);
  if (!client) {
    const serverName = manager.getServerName(language);
    return { via: "unavailable", hint: `Install ${serverName ?? "a language server"} for type info` };
  }

  try {
    const fileUri = pathToFileURL(join(index.root, pos.filePath)).href;
    const content = await readFile(join(index.root, pos.filePath), "utf-8");
    await client.openFile(fileUri, content, language);

    const result = await withTimeout(
      client.request<{ contents: unknown }>("textDocument/hover", {
        textDocument: { uri: fileUri },
        position: { line: pos.line, character: pos.character },
      }),
      LSP_TIMEOUT_MS,
      "LSP hover",
    );

    if (!result?.contents) return { via: "unavailable", hint: "No hover info at this position" };

    let typeStr: string;
    if (typeof result.contents === "string") {
      typeStr = result.contents;
    } else if (typeof result.contents === "object" && "value" in (result.contents as Record<string, unknown>)) {
      typeStr = (result.contents as { value: string }).value;
    } else if (Array.isArray(result.contents)) {
      typeStr = result.contents.map((c: unknown) => typeof c === "string" ? c : (c as { value?: string }).value ?? "").join("\n");
    } else {
      typeStr = String(result.contents);
    }

    // Split type from documentation
    const parts = typeStr.split("\n---\n");
    const type = parts[0]?.trim() ?? typeStr;
    const documentation = parts.length > 1 ? parts.slice(1).join("\n---\n").trim() : undefined;

    if (documentation) {
      return { type, documentation, via: "lsp" };
    }
    return { type, via: "lsp" };
  } catch {
    return { via: "unavailable", hint: "LSP hover request failed" };
  }
}

/**
 * Find references to a symbol using LSP textDocument/references.
 * Returns null if LSP is unavailable (caller should fall back to grep).
 */
export async function findReferencesLsp(
  repo: string,
  symbolName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<Reference[] | null> {
  const index = await getCodeIndex(repo);
  if (!index) return null;

  const pos = await resolveSymbolPosition(index, symbolName, filePath, line, character);
  if (!pos) return null;

  const language = detectLanguage(pos.filePath);
  if (!language) return null;

  const manager = getLspManager();
  const client = await manager.getClient(index.root, language);
  if (!client) return null;

  try {
    const fileUri = pathToFileURL(join(index.root, pos.filePath)).href;
    const content = await readFile(join(index.root, pos.filePath), "utf-8");
    await client.openFile(fileUri, content, language);

    const result = await withTimeout(
      client.request<unknown[]>("textDocument/references", {
        textDocument: { uri: fileUri },
        position: { line: pos.line, character: pos.character },
        context: { includeDeclaration: false },
      }),
      LSP_TIMEOUT_MS,
      "LSP references",
    );

    if (!Array.isArray(result)) return null;

    const rootUri = pathToFileURL(index.root).href + "/";
    return result.map((loc: any) => ({
      file: (loc.uri ?? "").replace(rootUri, ""),
      line: (loc.range?.start?.line ?? 0) + 1,
      col: (loc.range?.start?.character ?? 0) + 1,
      context: "",
    }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Call Hierarchy — LSP textDocument/prepareCallHierarchy + callHierarchy/*
// ---------------------------------------------------------------------------

export interface CallHierarchyItem {
  name: string;
  kind: string;
  file: string;
  line: number;
  detail?: string;
}

export interface CallHierarchyResult {
  symbol: CallHierarchyItem;
  incoming: CallHierarchyItem[];
  outgoing: CallHierarchyItem[];
  via: "lsp" | "unavailable";
  hint?: string;
}

/** LSP SymbolKind enum → human-readable */
function lspSymbolKindName(kind: number): string {
  const names: Record<number, string> = {
    1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class",
    6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum",
    11: "interface", 12: "function", 13: "variable", 14: "constant",
    15: "string", 16: "number", 17: "boolean", 18: "array", 19: "object",
    20: "key", 21: "null", 22: "enum_member", 23: "struct", 24: "event",
    25: "operator", 26: "type_parameter",
  };
  return names[kind] ?? "unknown";
}

/**
 * Get call hierarchy for a symbol: who calls it (incoming) and what it calls (outgoing).
 * Uses LSP textDocument/prepareCallHierarchy + callHierarchy/incomingCalls + callHierarchy/outgoingCalls.
 */
export async function getCallHierarchy(
  repo: string,
  symbolName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<CallHierarchyResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const pos = await resolveSymbolPosition(index, symbolName, filePath, line, character);
  if (!pos) return { symbol: { name: symbolName, kind: "unknown", file: "", line: 0 }, incoming: [], outgoing: [], via: "unavailable", hint: "Symbol not found in index" };

  const language = detectLanguage(pos.filePath);
  if (!language) return { symbol: { name: symbolName, kind: "unknown", file: pos.filePath, line: pos.line }, incoming: [], outgoing: [], via: "unavailable", hint: "Unsupported language for LSP" };

  const manager = getLspManager();
  const client = await manager.getClient(index.root, language);
  if (!client) {
    const serverName = manager.getServerName(language);
    return { symbol: { name: symbolName, kind: "unknown", file: pos.filePath, line: pos.line }, incoming: [], outgoing: [], via: "unavailable", hint: `Install ${serverName ?? "a language server"} for call hierarchy` };
  }

  const fileUri = pathToFileURL(join(index.root, pos.filePath)).href;
  const rootUri = pathToFileURL(index.root).href + "/";

  try {
    const content = await readFile(join(index.root, pos.filePath), "utf-8");
    await client.openFile(fileUri, content, language);

    // Prepare call hierarchy
    const items = await withTimeout(
      client.request<Array<{
        name: string;
        kind: number;
        uri: string;
        range: { start: { line: number; character: number } };
        detail?: string;
      }>>("textDocument/prepareCallHierarchy", {
        textDocument: { uri: fileUri },
        position: { line: pos.line, character: pos.character },
      }),
      LSP_TIMEOUT_MS,
      "LSP prepareCallHierarchy",
    );

    if (!items || items.length === 0) {
      return { symbol: { name: symbolName, kind: "unknown", file: pos.filePath, line: pos.line }, incoming: [], outgoing: [], via: "unavailable", hint: "No call hierarchy item at this position" };
    }

    const item = items[0]!;
    const symbol: CallHierarchyItem = {
      name: item.name,
      kind: lspSymbolKindName(item.kind),
      file: item.uri.replace(rootUri, ""),
      line: item.range.start.line + 1,
      ...(item.detail ? { detail: item.detail } : {}),
    };

    // Fetch incoming and outgoing calls in parallel
    const [incomingRaw, outgoingRaw] = await Promise.all([
      withTimeout(
        client.request<Array<{
          from: { name: string; kind: number; uri: string; range: { start: { line: number } }; detail?: string };
        }>>("callHierarchy/incomingCalls", { item }),
        LSP_TIMEOUT_MS,
        "LSP incomingCalls",
      ).catch(() => [] as never[]),
      withTimeout(
        client.request<Array<{
          to: { name: string; kind: number; uri: string; range: { start: { line: number } }; detail?: string };
        }>>("callHierarchy/outgoingCalls", { item }),
        LSP_TIMEOUT_MS,
        "LSP outgoingCalls",
      ).catch(() => [] as never[]),
    ]);

    const incoming: CallHierarchyItem[] = (incomingRaw ?? []).map((c) => ({
      name: c.from.name,
      kind: lspSymbolKindName(c.from.kind),
      file: c.from.uri.replace(rootUri, ""),
      line: c.from.range.start.line + 1,
      ...(c.from.detail ? { detail: c.from.detail } : {}),
    }));

    const outgoing: CallHierarchyItem[] = (outgoingRaw ?? []).map((c) => ({
      name: c.to.name,
      kind: lspSymbolKindName(c.to.kind),
      file: c.to.uri.replace(rootUri, ""),
      line: c.to.range.start.line + 1,
      ...(c.to.detail ? { detail: c.to.detail } : {}),
    }));

    return { symbol, incoming, outgoing, via: "lsp" };
  } catch {
    return { symbol: { name: symbolName, kind: "unknown", file: pos.filePath, line: pos.line }, incoming: [], outgoing: [], via: "unavailable", hint: "LSP call hierarchy request failed" };
  }
}

interface RenameEdit {
  file: string;
  changes: number;
}

export async function renameSymbol(
  repo: string,
  symbolName: string,
  newName: string,
  filePath?: string,
  line?: number,
  character?: number,
): Promise<{ files_changed: number; edits: RenameEdit[] }> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);

  const pos = await resolveSymbolPosition(index, symbolName, filePath, line, character);
  if (!pos) throw new Error(`Symbol "${symbolName}" not found in index.`);

  const language = detectLanguage(pos.filePath);
  if (!language) throw new Error("Unsupported language for LSP rename.");

  const manager = getLspManager();
  const client = await manager.getClient(index.root, language);
  if (!client) {
    const serverName = manager.getServerName(language);
    throw new Error(`rename_symbol requires a language server. Install ${serverName ?? "a language server"}.`);
  }

  const fileUri = pathToFileURL(join(index.root, pos.filePath)).href;
  const content = await readFile(join(index.root, pos.filePath), "utf-8");
  await client.openFile(fileUri, content, language);

  // Validate rename is possible
  try {
    await withTimeout(
      client.request("textDocument/prepareRename", {
        textDocument: { uri: fileUri },
        position: { line: pos.line, character: pos.character },
      }),
      LSP_TIMEOUT_MS,
      "LSP prepareRename",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot rename at this position: ${msg}`);
  }

  // Execute rename
  const workspaceEdit = await withTimeout(
    client.request<{
      changes?: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>>;
      documentChanges?: Array<{ textDocument: { uri: string }; edits: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }> }>;
    }>("textDocument/rename", {
      textDocument: { uri: fileUri },
      position: { line: pos.line, character: pos.character },
      newName,
    }),
    LSP_TIMEOUT_MS,
    "LSP rename",
  );

  // Normalize workspace edits
  const fileEdits = new Map<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>>();
  const rootUri = pathToFileURL(index.root).href + "/";

  if (workspaceEdit.changes) {
    for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
      fileEdits.set(uri.replace(rootUri, ""), edits);
    }
  } else if (workspaceEdit.documentChanges) {
    for (const docChange of workspaceEdit.documentChanges) {
      if ("edits" in docChange) {
        fileEdits.set(docChange.textDocument.uri.replace(rootUri, ""), docChange.edits);
      }
    }
  }

  // Apply edits to disk
  const results: RenameEdit[] = [];

  for (const [relPath, edits] of fileEdits) {
    const absPath = join(index.root, relPath);
    let fileContent: string;
    try {
      fileContent = await readFile(absPath, "utf-8");
    } catch { continue; }

    const lines = fileContent.split("\n");

    // Apply in reverse order to preserve line numbers
    const sortedEdits = [...edits].sort((a, b) => {
      const lineDiff = b.range.start.line - a.range.start.line;
      return lineDiff !== 0 ? lineDiff : b.range.start.character - a.range.start.character;
    });

    for (const edit of sortedEdits) {
      const startLine = edit.range.start.line;
      const startChar = edit.range.start.character;
      const endLine = edit.range.end.line;
      const endChar = edit.range.end.character;

      if (startLine === endLine) {
        const l = lines[startLine] ?? "";
        lines[startLine] = l.slice(0, startChar) + edit.newText + l.slice(endChar);
      } else {
        const firstLine = (lines[startLine] ?? "").slice(0, startChar);
        const lastLine = (lines[endLine] ?? "").slice(endChar);
        const newLines = (firstLine + edit.newText + lastLine).split("\n");
        lines.splice(startLine, endLine - startLine + 1, ...newLines);
      }
    }

    await writeFile(absPath, lines.join("\n"), "utf-8");
    results.push({ file: relPath, changes: edits.length });

    // Reindex changed file
    try { await indexFile(absPath); } catch { /* non-fatal */ }
  }

  return { files_changed: results.length, edits: results };
}
