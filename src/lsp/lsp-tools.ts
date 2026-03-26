import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getLspManager } from "./lsp-manager.js";
import { getCodeIndex } from "../tools/index-tools.js";
import type { CodeIndex, Reference } from "../types.js";

/** Map file extension to LSP language ID. */
export function detectLanguage(filePath: string): string | null {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".py": "python", ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php",
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

      const result = await client.request<unknown>("textDocument/definition", {
        textDocument: { uri: fileUri },
        position: { line: pos.line, character: pos.character },
      });

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

    const result = await client.request<unknown[]>("textDocument/references", {
      textDocument: { uri: fileUri },
      position: { line: pos.line, character: pos.character },
      context: { includeDeclaration: false },
    });

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
