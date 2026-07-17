import { getTestFixtures } from "../../pytest-tools.js";

export function runPytestFixtures(repo: string, file_pattern?: string) {
  return getTestFixtures(repo, file_pattern ? { file_pattern } : undefined);
}
