import type { CodeIndex } from "../../types.js";
import { checkAstroHydration } from "./checks/astro-hydration.js";
import { checkBlastRadius } from "./checks/blast-radius.js";
import { checkBreakingChanges } from "./checks/breaking.js";
import { checkBugPatterns } from "./checks/bug-patterns.js";
import { checkComplexityDelta } from "./checks/complexity.js";
import { checkCouplingGaps } from "./checks/coupling.js";
import { checkDeadCode } from "./checks/dead-code.js";
import { checkHotspots } from "./checks/hotspots.js";
import { checkSecrets } from "./checks/secrets.js";
import { checkTestGaps } from "./checks/test-gaps.js";
import type { CheckName } from "./constants.js";
import type { CheckResult } from "./types.js";

interface CheckContext {
  changedFiles: string[];
  index: CodeIndex;
  since: string;
  until: string;
}

export async function runCheck(
  checkName: CheckName,
  _repo: string,
  changedFiles: string[],
  index: CodeIndex,
  since: string,
  until: string,
): Promise<CheckResult> {
  const adapter = ({
    "blast-radius": ({ index, since, until }) => checkBlastRadius(index, since, until),
    secrets: ({ index, changedFiles }) => checkSecrets(index, changedFiles),
    "dead-code": ({ index, changedFiles }) => checkDeadCode(index, changedFiles),
    "bug-patterns": ({ index, changedFiles }) => checkBugPatterns(index, changedFiles),
    hotspots: ({ index, changedFiles }) => checkHotspots(index, changedFiles),
    complexity: ({ index, changedFiles }) => checkComplexityDelta(index, changedFiles),
    coupling: ({ index, changedFiles }) => checkCouplingGaps(index.root, changedFiles),
    breaking: ({ index, changedFiles, since, until }) =>
      checkBreakingChanges(index, index.root, changedFiles, since, until),
    "test-gaps": ({ index, changedFiles }) => checkTestGaps(index, changedFiles),
    "astro-hydration": ({ index, changedFiles }) => checkAstroHydration(index, changedFiles),
  } satisfies Record<CheckName, (context: CheckContext) => Promise<CheckResult>>)[checkName];

  return adapter({ changedFiles, index, since, until });
}
