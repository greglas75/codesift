export interface ImportEdge {
  from: string;
  to: string;
  type_only?: boolean;
  star_import?: boolean;
  raw?: string;
}

export type ImportEdgeExtras = Pick<ImportEdge, "type_only" | "star_import" | "raw">;

export type AddImportEdge = (
  from: string,
  to: string,
  extras?: ImportEdgeExtras,
) => void;

export interface PythonImportContext {
  disabled: boolean;
  indexedFiles: Set<string>;
  srcLayout: string | null;
}
