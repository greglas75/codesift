/**
 * Astro content collections analysis tool.
 *
 * Parses `src/content.config.ts` (or legacy `src/content/config.ts`) via the
 * tree-sitter-javascript AST walker and extracts:
 *   - Each `defineCollection(...)` entry (loader, schema fields)
 *   - Zod schema fields with their types + required flag
 *   - `reference("other")` edges to build a collection reference graph
 *   - Glob-resolved entries per loader pattern (default `src/content/<name>/`)
 *   - Frontmatter validation against required fields
 *
 * Exports `astroContentCollections(args)` as the MCP handler.
 */
import { getParser, initParser } from "../parser/parser-manager.js";
import { getCodeIndex } from "./index-tools.js";
import {
  discoverCollections,
  findConfig,
  readTextFile,
} from "./astro-content-collections/discovery.js";
import { buildCollectionDiagnostics } from "./astro-content-collections/diagnostics.js";
import type {
  ContentCollectionsResult,
  RawCollection,
} from "./astro-content-collections/types.js";

export type {
  CollectionInfo,
  CollectionSchemaField,
  ContentCollectionsResult,
  ContentValidationIssue,
} from "./astro-content-collections/types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface ContentCollectionsArgs {
  repo?: string;
  project_root?: string;
  validate_entries?: boolean;
}

type ConfigParseResult =
  | { status: "ok"; collections: RawCollection[] }
  | { status: "parser-unavailable" }
  | { status: "parse-error" };

function emptyResult(
  configFile: string | null,
  version: ContentCollectionsResult["config_version"],
): ContentCollectionsResult {
  return {
    config_file: configFile,
    config_version: version,
    collections: [],
    reference_graph: {},
    orphaned_files: [],
    validation_issues: [],
    summary: { total_collections: 0, total_entries: 0, collections_with_issues: 0 },
  };
}

function configErrorResult(
  configFile: string,
  version: ContentCollectionsResult["config_version"],
  message: string,
): ContentCollectionsResult {
  const result = emptyResult(configFile, version);
  result.validation_issues.push({
    collection: "$config",
    file: configFile,
    field: "$config",
    message,
    severity: "error",
  });
  result.summary.collections_with_issues = 1;
  return result;
}

async function resolveProjectRoot(args: ContentCollectionsArgs): Promise<string | null> {
  if (args.project_root) return args.project_root;
  const index = await getCodeIndex(args.repo ?? "");
  return index?.root ?? null;
}

async function parseConfigSource(source: string): Promise<ConfigParseResult> {
  await initParser();
  const parser = await getParser("javascript");
  if (!parser) return { status: "parser-unavailable" };
  try {
    return { status: "ok", collections: discoverCollections(parser.parse(source).rootNode) };
  } catch {
    return { status: "parse-error" };
  }
}

export async function astroContentCollections(
  args: ContentCollectionsArgs,
): Promise<ContentCollectionsResult> {
  const projectRoot = await resolveProjectRoot(args);
  if (!projectRoot) return emptyResult(null, "not-found");
  const discovered = await findConfig(projectRoot);
  if (!discovered) return emptyResult(null, "not-found");
  const source = await readTextFile(discovered.abs_path);
  if (source === null) return emptyResult(discovered.rel_path, "not-found");
  const parsed = await parseConfigSource(source);
  if (parsed.status === "parser-unavailable") {
    return configErrorResult(
      discovered.rel_path,
      discovered.version,
      "JavaScript parser unavailable",
    );
  }
  if (parsed.status === "parse-error") {
    return configErrorResult(
      discovered.rel_path,
      discovered.version,
      "Unable to parse content collection config",
    );
  }
  const diagnostics = await buildCollectionDiagnostics(
    projectRoot,
    parsed.collections,
    args.validate_entries ?? true,
  );

  return {
    config_file: discovered.rel_path,
    config_version: discovered.version,
    ...diagnostics,
  };
}
