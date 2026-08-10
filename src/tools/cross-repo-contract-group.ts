import type { RepoEndpoint } from "../types.js";
import { normalizePathParams } from "./cross-repo-contract-adapters.js";
import { instantiatesTemplate, matchContracts, matchesPartialPrefix } from "./cross-repo-contract-matcher.js";
import { defaultRepoResolver } from "./cross-repo-contract-resolver.js";
import {
  MAX_GROUP_REPOS,
  type GroupContractResult,
  type RepoContractData,
  type RepoResolver,
} from "./cross-repo-contract-types.js";
import type { OutboundCall } from "./cross-repo-outbound-calls.js";

/** Collected producer + consumer data for a whole group (pre-match). */
interface GroupData {
  producers: RepoEndpoint[];
  consumers: Array<OutboundCall & { repo: string }>;
  warnings: string[];
  repos_processed: number;
  error?: string;
}

/**
 * Answer "who calls what" across a registered repo group: extract producer
 * endpoints and consumer outbound calls for every indexed repo in the group,
 * then match them. Unindexed repos collect a warning and are skipped; a group
 * over MAX_GROUP_REPOS is capped with a truncation warning.
 */
async function collectGroupData(
  groupName: string,
  opts?: { registryPath?: string; resolver?: RepoResolver },
): Promise<GroupData> {
  const { getGroup, getGroupRegistryPath } = await import("../storage/group-registry.js");
  let registryPath = opts?.registryPath;
  if (!registryPath) {
    const { loadConfig } = await import("../config.js");
    registryPath = getGroupRegistryPath(loadConfig().dataDir);
  }

  const group = await getGroup(registryPath, groupName);
  if (!group) {
    return { producers: [], consumers: [], warnings: [], repos_processed: 0, error: `repo group "${groupName}" not found` };
  }

  const resolver = opts?.resolver ?? defaultRepoResolver;
  const warnings: string[] = [];

  let repos = group.repos;
  if (repos.length > MAX_GROUP_REPOS) {
    warnings.push(`group "${groupName}" has ${repos.length} repos; capped at ${MAX_GROUP_REPOS}`);
    repos = repos.slice(0, MAX_GROUP_REPOS);
  }

  const producers: RepoEndpoint[] = [];
  const consumers: Array<OutboundCall & { repo: string }> = [];
  let processed = 0;
  for (const repo of repos) {
    let data: RepoContractData;
    try {
      data = await resolver(repo);
    } catch (err: unknown) {
      warnings.push(`repo "${repo}" failed to resolve: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (data.warnings) warnings.push(...data.warnings);
    if (!data.indexed) {
      warnings.push(`repo "${repo}" is not indexed — skipped`);
      continue;
    }
    producers.push(...data.producers);
    consumers.push(...data.consumers);
    processed++;
  }

  return { producers, consumers, warnings, repos_processed: processed };
}

export async function matchGroupContracts(
  groupName: string,
  opts?: { registryPath?: string; resolver?: RepoResolver },
): Promise<GroupContractResult> {
  const d = await collectGroupData(groupName, opts);
  if (d.error) return { matches: [], warnings: d.warnings, repos_processed: d.repos_processed, error: d.error };
  return { matches: matchContracts(d.producers, d.consumers), warnings: d.warnings, repos_processed: d.repos_processed };
}

/**
 * Answer "who calls METHOD path" within a group. Returns producer↔consumer
 * `matches` for the endpoint AND `consumers_of_path` — every raw consumer call
 * hitting that path, INCLUDING calls to endpoints with no producer in the group
 * (an external/un-indexed service). Method is uppercased; the path is normalised
 * (`:id`/`{id}`/`[id]` → `{param}`) so any param style works.
 */
export async function findEndpointConsumers(
  groupName: string,
  method: string,
  path: string,
  opts?: { registryPath?: string; resolver?: RepoResolver },
): Promise<GroupContractResult> {
  const d = await collectGroupData(groupName, opts);
  if (d.error) return { matches: [], warnings: d.warnings, repos_processed: d.repos_processed, error: d.error };

  const wantMethod = method.toUpperCase();
  const wantPath = normalizePathParams(path);

  const matches = matchContracts(d.producers, d.consumers).filter(
    (m) => m.method === wantMethod && m.path === wantPath,
  );

  // Raw consumers of the queried path — independent of whether a group producer
  // serves it (covers external endpoints the group does not produce).
  const consumersOfPath = d.consumers.filter((c) => {
    if (c.method !== wantMethod) return false;
    return c.partial
      ? matchesPartialPrefix(c.url_prefix, wantPath)
      : instantiatesTemplate(c.url_prefix, wantPath);
  });

  return {
    matches,
    warnings: d.warnings,
    repos_processed: d.repos_processed,
    consumers_of_path: consumersOfPath,
  };
}
