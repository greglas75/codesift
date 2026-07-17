import { findFrameworkWiring } from "../../wiring-tools.js";

export function runFrameworkWiring(repo: string, file_pattern?: string) {
  return findFrameworkWiring(repo, file_pattern ? { file_pattern } : undefined);
}
