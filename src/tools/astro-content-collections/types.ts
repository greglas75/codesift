export interface CollectionSchemaField {
  name: string;
  type: string;
  required: boolean;
  references?: string;
}

export interface CollectionInfo {
  name: string;
  loader: "glob" | "file" | "custom" | "unknown";
  loader_pattern?: string;
  schema_fields: CollectionSchemaField[];
  entry_count: number;
  referenced_by: string[];
  references: string[];
}

export interface ContentValidationIssue {
  collection: string;
  file: string;
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ContentCollectionsResult {
  config_file: string | null;
  config_version: "v5+" | "legacy" | "not-found";
  collections: CollectionInfo[];
  reference_graph: Record<string, { field: string; cardinality: "one-to-one" | "many-to-one" }>;
  orphaned_files: string[];
  validation_issues: ContentValidationIssue[];
  summary: {
    total_collections: number;
    total_entries: number;
    collections_with_issues: number;
  };
}

export interface DiscoveredConfig {
  abs_path: string;
  rel_path: string;
  version: "v5+" | "legacy";
}

export interface LoaderInfo {
  kind: "glob" | "file" | "custom" | "unknown";
  pattern?: string;
  base?: string;
}

export interface ParsedField {
  name: string;
  type: string;
  required: boolean;
  references?: string;
}

export interface RawCollection {
  name: string;
  loader: LoaderInfo;
  fields: ParsedField[];
}

export type CollectionDiagnostics = Pick<
  ContentCollectionsResult,
  "collections" | "reference_graph" | "orphaned_files" | "validation_issues" | "summary"
>;
