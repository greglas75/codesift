/** Yii3 migration audit public facade. */
import { getCodeIndex } from "./index-tools.js";
import { buildYii3MigrationReport } from "./yii3-migration-report.js";
import { scanYii3MigrationSources } from "./yii3-migration-scanner.js";
import type { MigrationScanOptions } from "./yii3-migration-scanner.js";
import type { Yii3MigrationAudit } from "./yii3-migration-types.js";

export type {
  CategoryDefinition,
  CategoryFinding,
  EffortBucket,
  Severity,
  Yii3MigrationAudit,
  Yii3MigrationCategoryName,
} from "./yii3-migration-types.js";

export async function yii3MigrationAudit(
  repo: string,
  options?: MigrationScanOptions,
): Promise<Yii3MigrationAudit> {
  const index = await getCodeIndex(repo);
  if (!index) throw new Error(`Repository "${repo}" not found.`);
  const scan = await scanYii3MigrationSources(index, options);
  return buildYii3MigrationReport(repo, index.root, scan);
}
