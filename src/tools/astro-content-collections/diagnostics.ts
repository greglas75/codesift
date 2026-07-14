import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseFrontmatter, parseJsonEntry } from "./schema.js";
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

interface ReferenceIndex {
  graph: CollectionDiagnostics["reference_graph"];
  outgoing: Map<string, Set<string>>;
  incoming: Map<string, string[]>;
}

type EntryReadResult =
  | { kind: "data"; data: Record<string, unknown> }
  | { kind: "orphan" }
  | { kind: "skip" };

async function walkFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(fullPath, out);
    else if (entry.isFile()) out.push(fullPath);
  }
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index) : "";
}

function resolveLoaderBase(
  projectRoot: string,
  collectionName: string,
  loader: LoaderInfo,
): string {
  if (loader.base) {
    return isAbsolute(loader.base) ? loader.base : resolve(projectRoot, loader.base);
  }
  if (loader.kind === "file" && loader.pattern) {
    return resolve(projectRoot, dirname(loader.pattern));
  }
  return join(projectRoot, "src", "content", collectionName);
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
  const entryFiles: string[] = [];
  await walkFiles(
    resolveLoaderBase(projectRoot, collection.name, collection.loader),
    entryFiles,
  );
  return entryFiles.filter((file) => CONTENT_EXTENSIONS.has(extensionOf(file)));
}

async function readEntry(file: string): Promise<EntryReadResult> {
  const extension = extensionOf(file);
  if (FRONTMATTER_EXTENSIONS.has(extension)) {
    let source: string;
    try {
      source = await readFile(file, "utf-8");
    } catch {
      return { kind: "skip" };
    }
    const data = parseFrontmatter(source);
    return data ? { kind: "data", data } : { kind: "orphan" };
  }
  if (extension === ".json") {
    const data = await parseJsonEntry(file);
    return data ? { kind: "data", data } : { kind: "skip" };
  }
  return { kind: "skip" };
}

async function validateEntries(
  projectRoot: string,
  collection: RawCollection,
  files: string[],
): Promise<{ issues: ContentValidationIssue[]; orphanedFiles: string[] }> {
  const issues: ContentValidationIssue[] = [];
  const orphanedFiles: string[] = [];
  const requiredFields = collection.fields.filter((field) => field.required);
  for (const file of files) {
    const result = await readEntry(file);
    if (result.kind === "orphan") {
      orphanedFiles.push(relative(projectRoot, file));
      continue;
    }
    if (result.kind === "skip") continue;
    for (const field of requiredFields) {
      if (field.name in result.data) continue;
      issues.push({
        collection: collection.name,
        file: relative(projectRoot, file),
        field: field.name,
        message: `Missing required field '${field.name}' (${field.type})`,
        severity: "error",
      });
    }
  }
  return { issues, orphanedFiles };
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
    if (validate && rawCollection.fields.length > 0) {
      const validation = await validateEntries(projectRoot, rawCollection, files);
      validationIssues.push(...validation.issues);
      orphanedFiles.push(...validation.orphanedFiles);
    }
    collections.push(toCollectionInfo(rawCollection, files.length, references));
    totalEntries += files.length;
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
