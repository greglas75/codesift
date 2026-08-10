import type { RepoEndpoint } from "../types.js";
import { adaptHonoContract, adaptNestInventory, adaptNextjsContract } from "./cross-repo-contract-adapters.js";
import type { RepoContractData } from "./cross-repo-contract-types.js";
import { extractOutboundCalls, type OutboundCall } from "./cross-repo-outbound-calls.js";

/** Source extensions scanned for outbound consumer calls. */
const CONSUMER_SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cts", ".mts"]);

/**
 * Default repo resolver: real getCodeIndex → framework-detected producer
 * extraction (hono/nest/nextjs adapters) + indexed-source outbound scan.
 * Dynamic imports avoid a register-tools ↔ index-tools cycle at module load.
 */
async function defaultRepoResolver(repo: string): Promise<RepoContractData> {
  const { getCodeIndex } = await import("./index-tools.js");
  const index = await getCodeIndex(repo);
  if (!index) return { producers: [], consumers: [], indexed: false };

  const { detectFrameworks } = await import("../utils/framework-detect.js");
  const frameworks = detectFrameworks(index);

  // --- producers: run EVERY detected framework's extractor (a monorepo can
  // serve Hono + NestJS + Next.js side by side — an else-if chain would drop
  // all but the first). Each runs in its own try so one failure neither aborts
  // the others nor hides itself (it surfaces a per-framework warning).
  const producers: RepoEndpoint[] = [];
  const repoWarnings: string[] = [];
  const producerJobs: Array<[string, () => Promise<RepoEndpoint[]>]> = [];
  if (frameworks.has("hono")) {
    producerJobs.push(["hono", async () => {
      const { extractApiContract } = await import("./hono-api-contract.js");
      return adaptHonoContract(repo, await extractApiContract(repo, undefined, "summary"));
    }]);
  }
  if (frameworks.has("nestjs")) {
    producerJobs.push(["nestjs", async () => {
      const { nestRouteInventory } = await import("./nest-tools.js");
      return adaptNestInventory(repo, await nestRouteInventory(repo));
    }]);
  }
  if (frameworks.has("nextjs")) {
    producerJobs.push(["nextjs", async () => {
      const { nextjsApiContract } = await import("./nextjs-api-contract-tools.js");
      return adaptNextjsContract(repo, await nextjsApiContract(repo));
    }]);
  }
  for (const [fw, job] of producerJobs) {
    try {
      producers.push(...(await job()));
    } catch (err: unknown) {
      // Surface so a genuine extraction failure is distinguishable from "no endpoints".
      repoWarnings.push(`repo "${repo}" ${fw} producer extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- consumers: scan indexed source files for outbound fetch/axios/got calls,
  // in bounded-concurrency batches so a large repo does not serialize thousands
  // of awaited readFile calls (CQ17 — avoids per-call latency stacking).
  const { readFile } = await import("node:fs/promises");
  const { join, extname } = await import("node:path");
  const scanFiles = index.files.filter((fe) => CONSUMER_SOURCE_EXT.has(extname(fe.path)));
  const consumers: Array<OutboundCall & { repo: string }> = [];
  const CONSUMER_SCAN_CONCURRENCY = 16;
  for (let b = 0; b < scanFiles.length; b += CONSUMER_SCAN_CONCURRENCY) {
    const batch = scanFiles.slice(b, b + CONSUMER_SCAN_CONCURRENCY);
    const scans = await Promise.all(batch.map(async (fe) => {
      let src: string;
      try {
        src = await readFile(join(index.root, fe.path), "utf-8");
      } catch (err: unknown) {
        return {
          calls: [] as OutboundCall[],
          warning: `repo "${repo}" consumer scan failed for "${fe.path}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return { calls: extractOutboundCalls(src, fe.path) };
    }));
    for (const scan of scans) {
      if (scan.warning) repoWarnings.push(scan.warning);
      for (const call of scan.calls) consumers.push({ ...call, repo });
    }
  }

  return repoWarnings.length > 0
    ? { producers, consumers, indexed: true, warnings: repoWarnings }
    : { producers, consumers, indexed: true };
}

export { defaultRepoResolver };
