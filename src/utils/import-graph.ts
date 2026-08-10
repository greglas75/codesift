/**
 * Stable public facade for import-graph utilities.
 *
 * Keep consumers on this module while implementations remain split by
 * responsibility under ./import-graph/.
 */
export type { ImportEdge } from "./import-graph/types.js";
export { extractImports, extractBareImports } from "./import-graph/source-imports.js";
export { buildNormalizedPathMap, resolveImportPath } from "./import-graph/path-map.js";
export {
  buildKotlinFilesByBasename,
  extractKotlinImports,
  extractPhpUseStatements,
  resolveKotlinImport,
} from "./import-graph/language-imports.js";
export { buildWorkspaceAliasResolver } from "./import-graph/workspace-alias.js";
export { collectImportEdges } from "./import-graph/collect.js";
export { buildFilePageRank, buildImportAdjacency } from "./import-graph/metrics.js";
