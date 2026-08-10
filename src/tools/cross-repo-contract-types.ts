import type { ContractMatch, RepoEndpoint } from "../types.js";
import type { OutboundCall } from "./cross-repo-outbound-calls.js";

/** Hard cap on repos processed per group (CQ6 — bounds cross-repo fan-out). */
export const MAX_GROUP_REPOS = 20;

/** Producer endpoints + consumer outbound calls resolved for one repo. */
export interface RepoContractData {
  producers: RepoEndpoint[];
  consumers: Array<OutboundCall & { repo: string }>;
  /** False when the repo is not indexed — caller emits a warning and skips it. */
  indexed: boolean;
  /** Non-fatal per-repo notes (e.g. a producer extractor threw) surfaced to the caller. */
  warnings?: string[];
}

/** Resolves one repo's producer + consumer contract data. Injectable for tests. */
export type RepoResolver = (repo: string) => Promise<RepoContractData>;

export interface GroupContractResult {
  matches: ContractMatch[];
  warnings: string[];
  repos_processed: number;
  error?: string;
  /** Set by findEndpointConsumers: raw consumer calls hitting the queried path,
   * INCLUDING consumers of endpoints with no producer in the group (external
   * services). Without this, a consumer of an un-indexed producer is invisible. */
  consumers_of_path?: Array<OutboundCall & { repo: string }>;
}
