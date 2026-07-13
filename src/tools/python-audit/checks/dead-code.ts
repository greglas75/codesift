import { findDeadCode } from "../../symbol-tools.js";

export function runDeadCode(repo: string) {
  return findDeadCode(repo, { file_pattern: ".py" });
}
