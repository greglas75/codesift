import type { CodeIndex, CodeSymbol } from "../types.js";

/** Declarations indexed for resolving heritage names → defining file. */
const DECL_KINDS = new Set<CodeSymbol["kind"]>(["class", "interface", "type"]);

export interface HeritageFileEdge {
  from: string;
  to: string;
  kind: "extends" | "implements";
}

/** Counts of heritage refs that could not be turned into a file edge.
 * `ambiguous`: simple name matched 2+ declarations (collision).
 * `unresolved`: simple name matched no declared type. */
export interface HeritageResolutionStats {
  ambiguous: number;
  unresolved: number;
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

type HeritageResolution =
  | { status: "resolved"; file: string }
  | { status: "ambiguous" }
  | { status: "unresolved" };

function resolveHeritageTargetFile(
  raw: string,
  nameToFiles: Map<string, Set<string>>,
): HeritageResolution {
  const norm = normalizeHeritageRef(raw);
  if (!norm) return { status: "unresolved" };
  const candidates = [norm];
  const dot = norm.lastIndexOf(".");
  if (dot >= 0) candidates.push(norm.slice(dot + 1));
  let sawAmbiguous = false;
  for (const key of candidates) {
    const files = nameToFiles.get(key);
    if (!files) continue;
    if (files.size === 1) return { status: "resolved", file: [...files][0]! };
    sawAmbiguous = true;
  }
  return sawAmbiguous ? { status: "ambiguous" } : { status: "unresolved" };
}

/**
 * Best-effort module-level edges from symbol `extends` / `implements`.
 * Resolves each referenced type name to a file only when exactly one
 * declaration (class / interface / type alias) with that simple name exists.
 *
 * Returns the edge list and a `stats` block counting heritage refs that could
 * not be resolved (ambiguous: 2+ declarations with same simple name; unresolved:
 * no declared type with that name) so callers can surface the gap instead of
 * silently dropping edges.
 */
export function collectHeritageFileEdgesWithStats(index: CodeIndex): {
  edges: HeritageFileEdge[];
  stats: HeritageResolutionStats;
} {
  const nameToFiles = buildDeclaredTypeFiles(index);
  const out: HeritageFileEdge[] = [];
  const seen = new Set<string>();
  const stats: HeritageResolutionStats = { ambiguous: 0, unresolved: 0 };

  const push = (
    sym: CodeSymbol,
    names: string[] | undefined,
    kind: "extends" | "implements",
  ): void => {
    if (!names?.length) return;
    for (const raw of names) {
      const res = resolveHeritageTargetFile(raw, nameToFiles);
      if (res.status === "ambiguous") {
        stats.ambiguous += 1;
        continue;
      }
      if (res.status === "unresolved") {
        stats.unresolved += 1;
        continue;
      }
      if (res.file === sym.file) continue;
      const key = `${sym.file}|${res.file}|${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: sym.file, to: res.file, kind });
    }
  };

  for (const sym of index.symbols) {
    push(sym, sym.extends, "extends");
    push(sym, sym.implements, "implements");
  }

  return { edges: out, stats };
}

export function collectHeritageFileEdges(index: CodeIndex): HeritageFileEdge[] {
  return collectHeritageFileEdgesWithStats(index).edges;
}
