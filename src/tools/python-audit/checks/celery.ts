import { traceCeleryChain } from "../../celery-tools.js";

export function runCelery(repo: string, file_pattern?: string) {
  return traceCeleryChain(repo, file_pattern ? { file_pattern } : undefined);
}
