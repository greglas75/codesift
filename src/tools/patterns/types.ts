export interface BuiltinPatternDefinition {
  regex: RegExp;
  description: string;
  fileExcludePattern?: RegExp;
  fileIncludePattern?: RegExp;
  severity?: "critical" | "warning" | "style";
  postFilter?: (match: string) => boolean;
  /**
   * Preprocess source before regex matching while preserving character positions.
   */
  preprocess?: "strip-comments-strings";
}
