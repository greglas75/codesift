export {
  SEVERITY_MAP,
  classifyContext,
  enrichWithSymbolContext,
  getSeverity,
  isAllowlisted,
  isDocFile,
  maskSecret,
  offsetToLine,
} from "./secret-detectors.js";
export {
  getSecretCache,
  onFileChanged,
  onFileDeleted,
  resetSecretCache,
} from "./secret-scan-cache.js";
export {
  isMissingFileError,
  scanFileForSecrets,
  severityAtLeast,
  shouldSkipFile,
} from "./secret-file-scanner.js";
export type {
  SecretCacheEntry,
  SecretContext,
  SecretFinding,
  SecretSeverity,
} from "./secret-scan-types.js";
