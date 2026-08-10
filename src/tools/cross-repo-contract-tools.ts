/**
 * Stable public facade for cross-repo contract analysis.
 *
 * The implementation is split by responsibility so consumers keep the
 * historical module path without eagerly loading the registry or index tools.
 */

export {
  adaptHonoContract,
  adaptNestInventory,
  adaptNextjsContract,
  normalizePathParams,
} from "./cross-repo-contract-adapters.js";
export { findEndpointConsumers, matchGroupContracts } from "./cross-repo-contract-group.js";
export { matchContracts } from "./cross-repo-contract-matcher.js";
export { extractOutboundCalls } from "./cross-repo-outbound-calls.js";
export type { OutboundCall } from "./cross-repo-outbound-calls.js";
export { MAX_GROUP_REPOS } from "./cross-repo-contract-types.js";
export type {
  GroupContractResult,
  RepoContractData,
  RepoResolver,
} from "./cross-repo-contract-types.js";
