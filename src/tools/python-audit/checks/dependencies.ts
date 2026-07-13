import { parsePyproject } from "../../pyproject-tools.js";

export function runDependencies(repo: string) {
  return parsePyproject(repo);
}
