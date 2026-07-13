import { findPythonCircularImports } from "../../python-circular-imports.js";

export function runCircularImports(repo: string, file_pattern?: string) {
  return findPythonCircularImports(repo, file_pattern ? { file_pattern } : undefined);
}
