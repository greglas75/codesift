import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { parseFrontmatter, parseJsonEntry, parseYamlEntry } from "./schema.js";
import type {
  CollectionDiagnostics,
  CollectionInfo,
  CollectionSchemaField,
  ContentValidationIssue,
  LoaderInfo,
  RawCollection,
} from "./types.js";

const FRONTMATTER_EXTENSIONS = new Set([".md", ".mdx", ".mdoc", ".markdown"]);
const DATA_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const CONTENT_EXTENSIONS = new Set([...FRONTMATTER_EXTENSIONS, ...DATA_EXTENSIONS]);
const IGNORED_ROOT_DIRECTORIES = new Set([".astro", ".git", "dist", "node_modules"]);

interface ReferenceIndex {
  graph: CollectionDiagnostics["reference_graph"];
  outgoing: Map<string, Set<string>>;
  incoming: Map<string, string[]>;
}

type EntryReadResult =
  | { kind: "data"; entries: Record<string, unknown>[] }
  | { kind: "orphan" }
  | { kind: "invalid"; message: string }
  | { kind: "skip" };

async function walkFiles(dir: string, out: string[], pruneRootNoise: boolean): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (pruneRootNoise && entry.isDirectory() && IGNORED_ROOT_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(fullPath, out, pruneRootNoise);
    else if (entry.isFile()) out.push(fullPath);
  }
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index).toLowerCase() : "";
}

function resolveLoaderBase(
  projectRoot: string,
  collectionName: string,
  loader: LoaderInfo,
): string {
  if (loader.base) {
    return isAbsolute(loader.base) ? loader.base : resolve(projectRoot, loader.base);
  }
  if (loader.kind === "glob" && loader.pattern) return projectRoot;
  if (loader.kind === "file" && loader.pattern) {
    return resolve(projectRoot, dirname(loader.pattern));
  }
  return join(projectRoot, "src", "content", collectionName);
}

function isWithinProject(projectRoot: string, candidate: string): boolean {
  const relativePath = relative(resolve(projectRoot), resolve(candidate));
  return relativePath === ""
    || (relativePath !== ".."
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath));
}

async function resolveContainedRealPath(
  projectRoot: string,
  candidate: string,
): Promise<{ projectRoot: string; candidate: string } | null> {
  try {
    const [realProjectRoot, realCandidate] = await Promise.all([
      realpath(projectRoot),
      realpath(candidate),
    ]);
    return isWithinProject(realProjectRoot, realCandidate)
      ? { projectRoot: realProjectRoot, candidate: realCandidate }
      : null;
  } catch {
    return null;
  }
}

function staticGlobPrefix(pattern: string): string {
  const segments = pattern.replaceAll("\\", "/").split("/");
  const prefix: string[] = [];
  for (const segment of segments) {
    if (/[*?{[!@+(]/.test(segment)) break;
    prefix.push(segment);
  }
  return (prefix.length === segments.length ? prefix.slice(0, -1) : prefix).join("/");
}

function buildReferenceIndex(rawCollections: RawCollection[]): ReferenceIndex {
  const graph: CollectionDiagnostics["reference_graph"] = {};
  const outgoing = new Map<string, Set<string>>();
  for (const collection of rawCollections) {
    const targets = new Set<string>();
    for (const field of collection.fields) {
      if (!field.references) continue;
      targets.add(field.references);
      graph[`${collection.name}.${field.name}`] = {
        field: field.name,
        cardinality: field.type === "array" ? "many-to-one" : "one-to-one",
      };
    }
    outgoing.set(collection.name, targets);
  }

  const incoming = new Map<string, string[]>();
  for (const [source, targets] of outgoing) {
    for (const target of targets) {
      const sources = incoming.get(target) ?? [];
      sources.push(source);
      incoming.set(target, sources);
    }
  }
  return { graph, outgoing, incoming };
}

async function collectEntryFiles(
  projectRoot: string,
  collection: RawCollection,
): Promise<string[]> {
  if (collection.loader.kind === "file" && collection.loader.pattern) {
    const filePath = resolve(projectRoot, collection.loader.pattern);
    if (!isWithinProject(projectRoot, filePath) || !CONTENT_EXTENSIONS.has(extensionOf(filePath))) {
      return [];
    }
    const contained = await resolveContainedRealPath(projectRoot, filePath);
    return contained ? [filePath] : [];
  }

  const usesProjectRelativePattern = collection.loader.kind === "glob"
    && Boolean(collection.loader.pattern)
    && !collection.loader.base;
  const traversalCandidate = usesProjectRelativePattern
    ? resolve(projectRoot, staticGlobPrefix(collection.loader.pattern!))
    : resolveLoaderBase(projectRoot, collection.name, collection.loader);
  if (!isWithinProject(projectRoot, traversalCandidate)) return [];
  const contained = await resolveContainedRealPath(projectRoot, traversalCandidate);
  if (!contained) return [];
  const matchRoot = usesProjectRelativePattern ? resolve(projectRoot) : traversalCandidate;
  const entryFiles: string[] = [];
  await walkFiles(
    traversalCandidate,
    entryFiles,
    contained.candidate === contained.projectRoot,
  );
  const matcher = collection.loader.pattern
    ? picomatch(collection.loader.pattern, { dot: true })
    : null;
  return entryFiles.filter((file) => {
    if (!CONTENT_EXTENSIONS.has(extensionOf(file))) return false;
    const relativePath = relative(matchRoot, file).split(sep).join("/");
    return matcher ? matcher(relativePath) : true;
  });
}

async function readEntry(file: string): Promise<EntryReadResult> {
  const extension = extensionOf(file);
  if (FRONTMATTER_EXTENSIONS.has(extension)) {
    let source: string;
    try {
      source = await readFile(file, "utf-8");
    } catch {
      return { kind: "invalid", message: "Unreadable content entry" };
    }
    const parsed = await parseFrontmatter(source);
    if (!parsed) return { kind: "orphan" };
    return parsed.kind === "data"
      ? parsed
      : { kind: "invalid", message: "Invalid YAML frontmatter" };
  }
  if (extension === ".json") {
    const parsed = await parseJsonEntry(file);
    if (parsed.kind === "data") return parsed;
    return {
      kind: "invalid",
      message: parsed.kind === "parse-error"
        ? "Invalid JSON content entry"
        : "Unreadable JSON content entry",
    };
  }
  if (extension === ".yaml" || extension === ".yml") {
    const parsed = await parseYamlEntry(file);
    if (parsed.kind === "data") return parsed;
    return {
      kind: "invalid",
      message: parsed.kind === "parse-error"
        ? "Invalid YAML content entry"
        : "Unreadable YAML content entry",
    };
  }
  return { kind: "skip" };
}

function isMissingRequiredValue(data: Record<string, unknown>, field: string): boolean {
  if (!Object.hasOwn(data, field)) return true;
  const value = data[field];
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

async function inspectEntries(
  projectRoot: string,
  collection: RawCollection,
  files: string[],
  validate: boolean,
): Promise<{
  issues: ContentValidationIssue[];
  orphanedFiles: string[];
  entryCount: number;
}> {
  const issues: ContentValidationIssue[] = [];
  const orphanedFiles: string[] = [];
  const requiredFields = collection.fields.filter((field) => field.required);
  const reportRoot = resolve(projectRoot);
  let entryCount = 0;
  for (const file of files) {
    const result = await readEntry(file);
    if (result.kind === "orphan") {
      if (validate) orphanedFiles.push(relative(reportRoot, file));
      continue;
    }
    if (result.kind === "invalid") {
      if (validate) {
        issues.push({
          collection: collection.name,
          file: relative(reportRoot, file),
          field: "$",
          message: result.message,
          severity: "error",
        });
      }
      continue;
    }
    if (result.kind === "skip") {
      continue;
    }
    entryCount += result.entries.length;
    if (!validate) continue;
    for (const [entryIndex, data] of result.entries.entries()) {
      for (const field of requiredFields) {
        if (!isMissingRequiredValue(data, field.name)) continue;
        const fieldName = result.entries.length > 1 ? `[${entryIndex}].${field.name}` : field.name;
        issues.push({
          collection: collection.name,
          file: relative(reportRoot, file),
          field: fieldName,
          message: `Missing required field '${field.name}' (${field.type})`,
          severity: "error",
        });
      }
    }
  }
  return { issues, orphanedFiles, entryCount };
}

function toSchemaField(field: RawCollection["fields"][number]): CollectionSchemaField {
  const schemaField: CollectionSchemaField = {
    name: field.name,
    type: field.type,
    required: field.required,
  };
  if (field.references) schemaField.references = field.references;
  return schemaField;
}

function toCollectionInfo(
  collection: RawCollection,
  entryCount: number,
  references: ReferenceIndex,
): CollectionInfo {
  const info: CollectionInfo = {
    name: collection.name,
    loader: collection.loader.kind,
    schema_fields: collection.fields.map(toSchemaField),
    entry_count: entryCount,
    referenced_by: references.incoming.get(collection.name) ?? [],
    references: [...(references.outgoing.get(collection.name) ?? [])],
  };
  if (collection.loader.pattern) info.loader_pattern = collection.loader.pattern;
  return info;
}

export async function buildCollectionDiagnostics(
  projectRoot: string,
  rawCollections: RawCollection[],
  validate: boolean,
): Promise<CollectionDiagnostics> {
  const references = buildReferenceIndex(rawCollections);
  const collections: CollectionInfo[] = [];
  const validationIssues: ContentValidationIssue[] = [];
  const orphanedFiles: string[] = [];
  let totalEntries = 0;

  for (const rawCollection of rawCollections) {
    const files = await collectEntryFiles(projectRoot, rawCollection);
    const inspection = await inspectEntries(projectRoot, rawCollection, files, validate);
    validationIssues.push(...inspection.issues);
    orphanedFiles.push(...inspection.orphanedFiles);
    collections.push(toCollectionInfo(rawCollection, inspection.entryCount, references));
    totalEntries += inspection.entryCount;
  }

  return {
    collections,
    reference_graph: references.graph,
    orphaned_files: orphanedFiles,
    validation_issues: validationIssues,
    summary: {
      total_collections: collections.length,
      total_entries: totalEntries,
      collections_with_issues: new Set(validationIssues.map((issue) => issue.collection)).size,
    },
  };
}
