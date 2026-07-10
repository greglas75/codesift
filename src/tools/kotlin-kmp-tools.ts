import { getCodeIndex } from "./index-tools.js";
import type { CodeIndex, CodeSymbol } from "../types.js";

export interface KmpMatchedDeclaration {
  name: string;
  kind: string;
  expect_source_set: string;
  actual_source_sets: string[];
}
export interface KmpMissingDeclaration {
  name: string;
  kind: string;
  source_set: string;
  missing_from: string[];
}
export interface KmpOrphanDeclaration {
  name: string;
  kind: string;
  source_set: string;
  file: string;
}
export interface KmpAnalysisResult {
  total_expects: number;
  fully_matched: number;
  source_sets_detected: string[];
  matched: KmpMatchedDeclaration[];
  missing_actuals: KmpMissingDeclaration[];
  orphan_actuals: KmpOrphanDeclaration[];
}

interface GroupedDeclarations {
  expects: Array<{ sym: CodeSymbol; sourceSet: string }>;
  actuals: Array<{ sym: CodeSymbol; sourceSet: string }>;
}

function parseSourceSet(filePath: string): string | null {
  return /src\/(\w+Main)\/kotlin\//.exec(filePath)?.[1] ?? null;
}

function collectSourceSets(index: CodeIndex): Set<string> {
  const sourceSets = new Set<string>();
  for (const file of index.files) {
    const sourceSet = parseSourceSet(file.path);
    if (sourceSet) sourceSets.add(sourceSet);
  }
  return sourceSets;
}

function groupDeclarations(index: CodeIndex): Map<string, GroupedDeclarations> {
  const groups = new Map<string, GroupedDeclarations>();
  for (const symbol of index.symbols) {
    const modifier = symbol.meta?.["kmp_modifier"];
    if (modifier !== "expect" && modifier !== "actual") continue;
    const sourceSet = parseSourceSet(symbol.file);
    if (!sourceSet) continue;
    const key = `${symbol.kind}::${symbol.name}`;
    const group = groups.get(key) ?? { expects: [], actuals: [] };
    groups.set(key, group);
    if (modifier === "expect") group.expects.push({ sym: symbol, sourceSet });
    else group.actuals.push({ sym: symbol, sourceSet });
  }
  return groups;
}

function appendOrphans(
  group: GroupedDeclarations,
  orphanActuals: KmpOrphanDeclaration[],
): void {
  for (const { sym, sourceSet } of group.actuals) {
    orphanActuals.push({ name: sym.name, kind: sym.kind, source_set: sourceSet, file: sym.file });
  }
}

function appendExpectedResults(
  group: GroupedDeclarations,
  platformSourceSets: string[],
  result: KmpAnalysisResult,
): void {
  for (const expected of group.expects) {
    const actualSets = group.actuals.map((actual) => actual.sourceSet);
    const missingFrom = platformSourceSets.filter((sourceSet) => !actualSets.includes(sourceSet));
    if (missingFrom.length === 0 && actualSets.length > 0) result.fully_matched++;
    if (actualSets.length > 0) {
      result.matched.push({
        name: expected.sym.name,
        kind: expected.sym.kind,
        expect_source_set: expected.sourceSet,
        actual_source_sets: actualSets,
      });
    }
    if (missingFrom.length > 0) {
      result.missing_actuals.push({
        name: expected.sym.name,
        kind: expected.sym.kind,
        source_set: expected.sourceSet,
        missing_from: missingFrom,
      });
    }
  }
}

function buildAnalysis(
  groups: Map<string, GroupedDeclarations>,
  sourceSets: Set<string>,
): KmpAnalysisResult {
  const result: KmpAnalysisResult = {
    total_expects: [...groups.values()].reduce((count, group) => count + group.expects.length, 0),
    fully_matched: 0,
    source_sets_detected: [...sourceSets].sort(),
    matched: [],
    missing_actuals: [],
    orphan_actuals: [],
  };
  const platformSourceSets = [...sourceSets].filter((sourceSet) => sourceSet !== "commonMain");
  for (const group of groups.values()) {
    if (group.expects.length === 0) appendOrphans(group, result.orphan_actuals);
    else appendExpectedResults(group, platformSourceSets, result);
  }
  return result;
}

/** Match Kotlin Multiplatform expect/actual declarations across source sets. */
export async function analyzeKmpDeclarations(repo: string): Promise<KmpAnalysisResult> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found. Index it first with index_folder.`);
  return buildAnalysis(groupDeclarations(index), collectSourceSets(index));
}
