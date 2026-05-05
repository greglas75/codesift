import type { CodeIndex, CodeSymbol } from "../types.js";

/** Declarations indexed for resolving heritage names → defining file. */
const DECL_KINDS = new Set<CodeSymbol["kind"]>(["class", "interface", "type"]);

export interface HeritageFileEdge {
  from: string;
  to: string;
  kind: "extends" | "implements";
}

function stripTrailingGeneric(name: string): string {
  const i = name.indexOf("<");
  return i >= 0 ? name.slice(0, i) : name;
}

function normalizeHeritageRef(raw: string): string {
  const compact = raw.replace(/\s+/g, "");
  const lt = compact.indexOf("<");
  return lt >= 0 ? compact.slice(0, lt) : compact;
}

function buildDeclaredTypeFiles(index: CodeIndex): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const s of index.symbols) {
    if (!DECL_KINDS.has(s.kind)) continue;
    const baseName = stripTrailingGeneric(s.name).trim();
    if (!baseName) continue;
    let set = map.get(baseName);
    if (!set) {
      set = new Set();
      map.set(baseName, set);
    }
    set.add(s.file);
  }
  return map;
}

function resolveHeritageTargetFile(
  raw: string,
  nameToFiles: Map<string, Set<string>>,
): string | null {
  const norm = normalizeHeritageRef(raw);
  if (!norm) return null;
  const candidates = [norm];
  const dot = norm.lastIndexOf(".");
  if (dot >= 0) candidates.push(norm.slice(dot + 1));
  for (const key of candidates) {
    const files = nameToFiles.get(key);
    if (files?.size === 1) return [...files][0]!;
  }
  return null;
}

/**
 * Best-effort module-level edges from symbol `extends` / `implements`.
 * Resolves each referenced type name to a file only when exactly one
 * declaration (class / interface / type alias) with that simple name exists.
 */
export function collectHeritageFileEdges(index: CodeIndex): HeritageFileEdge[] {
  const nameToFiles = buildDeclaredTypeFiles(index);
  const out: HeritageFileEdge[] = [];
  const seen = new Set<string>();

  const push = (
    sym: CodeSymbol,
    names: string[] | undefined,
    kind: "extends" | "implements",
  ): void => {
    if (!names?.length) return;
    for (const raw of names) {
      const toFile = resolveHeritageTargetFile(raw, nameToFiles);
      if (!toFile || toFile === sym.file) continue;
      const key = `${sym.file}|${toFile}|${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: sym.file, to: toFile, kind });
    }
  };

  for (const sym of index.symbols) {
    push(sym, sym.extends, "extends");
    push(sym, sym.implements, "implements");
  }

  return out;
}
