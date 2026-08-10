// ---------------------------------------------------------------------------
// CLI command dispatch facade
// ---------------------------------------------------------------------------

import type { Flags } from "./args.js";
import { handleServe } from "./commands-daemon.js";
import {
  handleIndex,
  handleIndexRepo,
  handleRepos,
  handleInvalidate,
  handleIndexConversations,
} from "./commands-index.js";
import { handlePrune, handleCleanupProcesses } from "./commands-maintenance.js";
import {
  handleSearch,
  handleSymbols,
  handleTree,
  handleOutline,
  handleRepoOutline,
  handleSymbol,
  handleSymbolsBatch,
  handleFind,
  handleRefs,
  handleTrace,
  handleImpact,
  handleContext,
  handleKnowledgeMap,
  handleDiff,
  handleChanged,
  handleRetrieve,
  handleStats,
  handleGenerateClaudeMd,
} from "./commands-query.js";
import {
  handleComplexity,
  handleDeadCode,
  handleHotspots,
  handleCommunities,
  handlePatterns,
  handleSetup,
  handleFindClones,
  handleService,
} from "./commands-admin.js";

export {
  DEFAULT_DAEMON_PORT,
  daemonLockPaths,
  isProcessAlive,
  readDaemonLock,
  startDaemon,
} from "./commands-daemon.js";
export type { DaemonHandle } from "./commands-daemon.js";

export type CommandHandler = (args: string[], flags: Flags) => Promise<void>;

// ---------------------------------------------------------------------------
// Command dispatch map
// ---------------------------------------------------------------------------

export const COMMAND_MAP: Record<string, CommandHandler> = {
  "index": handleIndex,
  "index-repo": handleIndexRepo,
  "repos": handleRepos,
  "invalidate": handleInvalidate,
  "prune": handlePrune,
  "cleanup-processes": handleCleanupProcesses,
  "serve": handleServe,
  "service": handleService,
  "index-conversations": handleIndexConversations,
  "search": handleSearch,
  "symbols": handleSymbols,
  "tree": handleTree,
  "outline": handleOutline,
  "repo-outline": handleRepoOutline,
  "symbol": handleSymbol,
  "symbols-batch": handleSymbolsBatch,
  "find": handleFind,
  "refs": handleRefs,
  "trace": handleTrace,
  "impact": handleImpact,
  "context": handleContext,
  "knowledge-map": handleKnowledgeMap,
  "diff": handleDiff,
  "changed": handleChanged,
  "retrieve": handleRetrieve,
  "stats": handleStats,
  "generate-claude-md": handleGenerateClaudeMd,
  "complexity": handleComplexity,
  "dead-code": handleDeadCode,
  "hotspots": handleHotspots,
  "communities": handleCommunities,
  "patterns": handlePatterns,
  "find-clones": handleFindClones,
  "setup": handleSetup,
  "telemetry": async (args: string[], _flags: Flags) => {
    const { handleTelemetry } = await import("./telemetry-commands.js");
    await handleTelemetry(args);
  },
  "wiki-generate": async (args: string[], flags: Flags) => {
    const { handleWikiGenerate } = await import("./wiki-commands.js");
    await handleWikiGenerate(args, flags);
  },
  "wiki-lint": async (args: string[], flags: Flags) => {
    const { handleWikiLint } = await import("./wiki-commands.js");
    await handleWikiLint(args, flags);
  },
  "journal-init": async (args: string[], flags: Flags) => {
    const { handleJournalInit } = await import("./journal-commands.js");
    await handleJournalInit(args, flags);
  },
  "journal-append": async (args: string[], flags: Flags) => {
    const { handleJournalAppend } = await import("./journal-commands.js");
    await handleJournalAppend(args, flags);
  },
  "journal-refresh-overview": async (args: string[], flags: Flags) => {
    const { handleJournalRefreshOverview } = await import("./journal-commands.js");
    await handleJournalRefreshOverview(args, flags);
  },
  "journal-regenerate": async (args: string[], flags: Flags) => {
    const { handleJournalRegenerate } = await import("./journal-commands.js");
    await handleJournalRegenerate(args, flags);
  },
  "journal-lint": async (args: string[], flags: Flags) => {
    const { handleJournalLint } = await import("./journal-commands.js");
    await handleJournalLint(args, flags);
  },
  "journal-migrate": async (args: string[], flags: Flags) => {
    const { handleJournalMigrate } = await import("./journal-commands.js");
    await handleJournalMigrate(args, flags);
  },
  "journal-stats": async (args: string[], flags: Flags) => {
    const { handleJournalStats } = await import("./journal-commands.js");
    await handleJournalStats(args, flags);
  },
  "precheck-read": async () => {
    const { handlePrecheckRead } = await import("./hooks.js");
    await handlePrecheckRead();
  },
  "precheck-bash": async () => {
    const { handlePrecheckBash } = await import("./hooks.js");
    await handlePrecheckBash();
  },
  "precheck-glob": async () => {
    const { handlePrecheckGlob } = await import("./hooks.js");
    await handlePrecheckGlob();
  },
  "precheck-grep": async () => {
    const { handlePrecheckGrep } = await import("./hooks.js");
    await handlePrecheckGrep();
  },
  "precheck-agent": async () => {
    const { handlePrecheckAgent } = await import("./hooks.js");
    await handlePrecheckAgent();
  },
  "session-start": async () => {
    const { handleSessionStart } = await import("./hooks.js");
    await handleSessionStart();
  },
  "session-gate": async () => {
    const { handleSessionGate } = await import("./hooks.js");
    await handleSessionGate();
  },
  "sentinel-writer": async () => {
    const { handleSentinelWriter } = await import("./hooks.js");
    await handleSentinelWriter();
  },
  "postindex-file": async () => {
    const { handlePostindexFile } = await import("./hooks.js");
    await handlePostindexFile();
  },
  "precompact-snapshot": async () => {
    const { handlePrecompactSnapshot } = await import("./hooks.js");
    await handlePrecompactSnapshot();
  },
};
