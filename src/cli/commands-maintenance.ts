import { execFileSync } from "node:child_process";
import type { Flags } from "./args.js";
import { getBoolFlag, output, die } from "./args.js";

/**
 * Delete orphaned per-repo cache artifacts (embeddings/index/meta/bm25/graph)
 * whose hash stem is no longer in the registry. These accumulate from
 * re-indexes (hash changes) and ephemeral/test repos that were indexed then
 * deleted — each leaves multi-GB embedding files behind. Use --dry-run to
 * preview. Regenerable: re-indexing recreates anything still needed.
 */
async function handlePrune(_args: string[], flags: Flags): Promise<void> {
  const { loadConfig } = await import("../config.js");
  const { withRegistryLock } = await import("../storage/registry.js");
  const registryPath = loadConfig().registryPath;
  await withRegistryLock(registryPath, () => handlePruneLocked(flags, registryPath));
}

async function handlePruneLocked(flags: Flags, registryPath: string): Promise<void> {
  const { readFileSync, readdirSync, statSync, unlinkSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { loadConfig } = await import("../config.js");
  const dataDir = loadConfig().dataDir;
  const dryRun = getBoolFlag(flags, "dry-run");
  const pruneGraceMs = 5 * 60 * 1000;

  // Live index hashes from the registry — everything else is orphaned cache.
  //
  // A registry entry counted as live even when its `root` no longer existed, so
  // artifacts for deleted directories were protected indefinitely. Measured
  // here: 101 of 119 indexed worktrees pointed at directories that were gone,
  // holding 5.4 GB of embeddings for code that cannot be read. Task branches are
  // created and deleted constantly, so this accumulates without bound.
  //
  // Entries whose root is missing are de-registered first; their artifacts then
  // fall out as orphans through the sweep below.
  const live = new Set<string>();
  const stale: Array<{ name: string; root: string }> = [];
  const staleHashes = new Set<string>();
  let reg: {
    repos?: Record<string, {
      name?: string;
      index_path?: string;
      root?: string;
      symbol_count?: number;
      file_count?: number;
      updated_at?: number;
    }>;
    updated_at?: number;
  };
  let registryDirty = false;
  try {
    reg = JSON.parse(readFileSync(registryPath, "utf-8")) as typeof reg;
  } catch {
    die("prune: cannot read registry.json — aborting so live data is never deleted.");
    return;
  }
  for (const [name, v] of Object.entries(reg.repos ?? {})) {
    const ip = v.index_path;
    const root = v.root;
    // Only a root that is definitively absent counts. An unreadable path (a
    // permissions error, an unmounted volume mid-check) throws and is treated
    // as present — the conservative direction, since the cost of keeping a dead
    // entry is disk, and the cost of dropping a live one is a re-index.
    let rootGone = false;
    if (typeof root === "string" && root.length > 0) {
      try {
        statSync(root);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        rootGone = code === "ENOENT" || code === "ENOTDIR";
      }
    }
    if (rootGone) {
      stale.push({ name, root: root as string });
      if (typeof ip === "string") {
        const stem = /^([0-9a-f]{8,})\./.exec(ip.split("/").pop() ?? "")?.[1];
        if (stem) staleHashes.add(stem);
      }
      continue; // deliberately NOT added to `live`
    }
    // Take the HASH STEM with the same shape the sweep below matches, rather than stripping one
    // known suffix. `.replace(".index.json", "")` silently no-ops on any other form — so after the
    // SQLite migration an entry whose `index_path` ends in `.index.db` never reached this set, and
    // every artifact under that hash looked orphaned. Measured 2026-08-07 on one such entry:
    // 8.33 GB of LIVE data (a 240,706-symbol index plus 3.9 GB of embeddings) was one `prune` away
    // from deletion. Deriving the stem the same way in both halves of this command is what makes
    // them agree by construction instead of by coincidence.
    if (typeof ip === "string") {
      const stem = /^([0-9a-f]{8,})\./.exec(ip.split("/").pop() ?? "")?.[1];
      if (stem) live.add(stem);
    }
  }
  // An index database is LIVE if its own `meta` says it describes a directory that still exists —
  // whether or not the registry knows about it.
  //
  // The registry is not the authority on what exists; it is a lookup table, and it drifts. Measured
  // 2026-08-07: `local/tgm-survey-platform` had been re-registered onto a worktree that was later
  // deleted, leaving the MAIN checkout's index — 240,706 symbols, and 8.33 GB once its embeddings
  // are counted — described by no entry at all. Prune classified every byte of it as orphaned.
  // Twenty-four hours later three MORE databases had drifted the same way, so this is a rate, not
  // an incident.
  //
  // Asking each database who it is costs one small read per unregistered hash, and removes a whole
  // class of data loss: a repo still present on disk can no longer be deleted because a JSON file
  // lost track of it. Re-registering also means the next lookup finds it.
  const rescued: string[] = [];
  const rescuedNames = new Set<string>();
  const protectedNames = new Set<string>();
  for (const name of readdirSync(dataDir)) {
    const m = /^([0-9a-f]{8,})\.index\.db$/.exec(name);
    if (!m?.[1] || live.has(m[1])) continue;
    let db: import("node:sqlite").DatabaseSync | undefined;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      db = new DatabaseSync(`file:${join(dataDir, name)}?mode=ro`, { open: true });
      const rows = db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>;
      const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      const root = meta["root"];
      const repo = meta["repo"];
      if (!root || !repo) {
        live.add(m[1]);
        continue;
      }
      statSync(root); // throws when the tree is gone — then it really is garbage

      // The live guard above is keyed by hash, while registration replaces an
      // entry by repository name. Do not let an orphan database repoint a
      // healthy entry that already owns the same name.
      const existing = reg.repos?.[repo];
      if (existing?.root) {
        let existingGone = false;
        try {
          statSync(existing.root);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          existingGone = code === "ENOENT" || code === "ENOTDIR";
        }
        if (!existingGone) {
          // Same root means this database is an older generation and may be
          // swept. A different live root is ambiguous, so preserve both and
          // leave registry reconciliation to an explicit operator action.
          if (existing.root !== root) {
            live.add(m[1]);
            protectedNames.add(repo);
          }
          continue;
        }
      }

      live.add(m[1]);
      protectedNames.add(repo);
      if (!dryRun) {
        // Canonical `.index.json` form: `sqlitePathFor()` derives the `.db` from it, and the
        // live-set above is built from these strings.
        reg.repos ??= {};
        const previous = reg.repos[repo];
        const replacement: NonNullable<typeof reg.repos>[string] = {
          name: repo,
          root,
          index_path: join(dataDir, `${m[1]}.index.json`),
        };
        if (typeof previous?.symbol_count === "number" && Number.isFinite(previous.symbol_count)) {
          replacement.symbol_count = previous.symbol_count;
        }
        if (typeof previous?.file_count === "number" && Number.isFinite(previous.file_count)) {
          replacement.file_count = previous.file_count;
        }
        if (typeof previous?.updated_at === "number" && Number.isFinite(previous.updated_at)) {
          replacement.updated_at = previous.updated_at;
        }
        reg.repos[repo] = replacement;
        registryDirty = true;
      }
      rescued.push(repo);
      rescuedNames.add(repo);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Only definite absence makes the database garbage. Any other I/O or
      // permission failure is inconclusive, so preserve this hash.
      if (code !== "ENOENT" && code !== "ENOTDIR") live.add(m[1]);
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
  }

  // Safety: an empty live set would mark every artifact orphaned. Refuse rather
  // than risk nuking a valid (but momentarily empty-looking) data dir.
  if (live.size === 0) {
    die("prune: registry lists 0 repos — aborting (refusing to treat all artifacts as orphans).");
  }

  // Commit every registry rescue/removal before deleting derived files. If the
  // atomic registry write fails, prune exits with all artifacts still intact.
  if (!dryRun && stale.length > 0) {
    const staleNames = new Set(
      stale
        .filter((entry) => !rescuedNames.has(entry.name) && !protectedNames.has(entry.name))
        .map((entry) => entry.name),
    );
    const effectiveRepoCount = Object.keys(reg.repos ?? {})
      .filter((name) => !staleNames.has(name)).length;
    if (effectiveRepoCount === 0) {
      die("prune: every registry entry is stale — aborting before registry or artifacts change.");
    }
    for (const s of stale) {
      if (!rescuedNames.has(s.name) && !protectedNames.has(s.name)) {
        if (reg.repos && s.name in reg.repos) {
          delete reg.repos[s.name];
          registryDirty = true;
        }
      }
    }
  }
  if (registryDirty) {
    reg.updated_at = Date.now();
    const { saveRegistryUnderLock } = await import("../storage/registry.js");
    await saveRegistryUnderLock(registryPath, reg as never);
  }

  // Suffix list lives with the helpers that build these names, so a new artifact kind
  // cannot quietly become unreclaimable garbage — see ARTIFACT_SUFFIXES.
  const { artifactPattern } = await import("../storage/_shared.js");
  const re = artifactPattern();
  const registryProtectsHash = (hash: string): boolean => {
    try {
      const fresh = JSON.parse(
        readFileSync(registryPath, "utf-8"),
      ) as typeof reg;
      return Object.values(fresh.repos ?? {}).some((entry) => {
        const file = entry.index_path?.split("/").pop() ?? "";
        return /^([0-9a-f]{8,})\./.exec(file)?.[1] === hash;
      });
    } catch {
      // An inconclusive registry read must protect data, not authorize deletion.
      return true;
    }
  };
  let files = 0, bytes = 0, kept = 0;
  for (const name of readdirSync(dataDir)) {
    const m = re.exec(name);
    if (!m) continue;
    // A stale entry removed during THIS run gets one full run of retention.
    // The next prune re-evaluates its database metadata before collecting it.
    if (live.has(m[1]!) || staleHashes.has(m[1]!)) { kept++; continue; }
    const full = join(dataDir, name);
    try {
      const fileStat = statSync(full);
      // A fresh artifact may belong to an index operation that has not yet
      // committed its registry entry. Delay collection for one run and also
      // re-read registry immediately before every destructive unlink.
      const ageMs = Date.now() - fileStat.mtimeMs;
      if (ageMs < pruneGraceMs || registryProtectsHash(m[1]!)) {
        kept++;
        continue;
      }
      if (!dryRun) unlinkSync(full);
      bytes += fileStat.size;
      files++;
    } catch { /* skip unreadable/already-gone */ }
  }

  // Shared-cache versions have no repository hash prefix, so the artifact
  // sweep cannot discover superseded formats. Keep the current version and
  // reclaim only older derived cache files.
  const { currentSharedCacheFilename } = await import("../storage/shared-embedding-cache.js");
  const currentShared = currentSharedCacheFilename();
  const currentVersion = Number(/^shared-embeddings\.v(\d+)\.bin$/.exec(currentShared)?.[1]);
  for (const name of readdirSync(dataDir)) {
    const match = /^shared-embeddings\.v(\d+)\.(?:bin|ndjson)$/.exec(name);
    if (!match?.[1] || name === currentShared || !Number.isFinite(currentVersion) ||
        Number(match[1]) >= currentVersion) continue;
    const full = join(dataDir, name);
    try {
      const fileStat = statSync(full);
      const ageMs = Date.now() - fileStat.mtimeMs;
      if (ageMs < pruneGraceMs) continue;
      if (!dryRun) unlinkSync(full);
      bytes += fileStat.size;
      files++;
    } catch { /* skip unreadable/already-gone */ }
  }

  output({
    rescued_repos: rescued.length,
    rescued_examples: rescued.slice(0, 5),
    stale_repos: stale.length,
    stale_examples: stale.slice(0, 5).map((s) => s.name),
    pruned: !dryRun,
    dry_run: dryRun,
    orphan_files: files,
    freed_gb: +(bytes / 1e9).toFixed(2),
    kept_live_artifacts: kept,
    data_dir: dataDir,
  }, flags);
}

type ProcessRow = { pid: number; ppid: number; rssKb: number; command: string };

function listProcesses(): ProcessRow[] {
  const raw = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const rows: ProcessRow[] = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      command: match[4] ?? "",
    });
  }
  return rows;
}

function classifyCleanupTarget(command: string, includeGlobalCodesift: boolean): string | null {
  const node = String.raw`(?:node|\S*/node)`;
  const npm = String.raw`(?:npm|\S*/npm)`;
  if (command === "" || /(?:^|\s)codesift\s+cleanup-processes(?:\s|$)/.test(command)) return null;
  if (new RegExp(`^${node}\\s+/Users/\\S+/DEV/codesift-mcp/dist/server\\.js(?:\\s|$)`).test(command)) {
    return "legacy-dev-dist-server";
  }
  if (new RegExp(`^${npm}\\s+exec\\s+chrome-devtools-mcp(?:@\\S+)?(?:\\s|$)`).test(command) ||
      /^(?:\S*\/)?chrome-devtools-mcp(?:\s|$)/.test(command)) {
    return "chrome-devtools-mcp";
  }
  if (new RegExp(`^${node}\\s+\\S*chrome-devtools-mcp/\\S*/watchdog/main\\.js(?:\\s|$)`).test(command)) {
    return "chrome-devtools-watchdog";
  }
  if (new RegExp(`^${npm}\\s+exec\\s+@sentry/mcp-server(?:@\\S+)?(?:\\s|$)`).test(command)) {
    return "sentry-mcp";
  }
  if (new RegExp(`^${npm}\\s+exec\\s+@playwright/mcp(?:@\\S+)?(?:\\s|$)`).test(command)) {
    return "playwright-mcp";
  }
  if (includeGlobalCodesift &&
      new RegExp(`^(?:${node}\\s+)?/Users/\\S+/.npm-global/bin/codesift-mcp(?:\\s|$)`).test(command)) {
    return "global-codesift-mcp";
  }
  return null;
}

function currentProcessCommand(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    }).trim() || null;
  } catch {
    return null;
  }
}

async function handleCleanupProcesses(_args: string[], flags: Flags): Promise<void> {
  const dryRun = getBoolFlag(flags, "dry-run") === true;
  const includeGlobalCodesift = getBoolFlag(flags, "global-codesift") === true;
  const rows = listProcesses();
  const targets = rows
    .map((row) => ({ ...row, reason: classifyCleanupTarget(row.command, includeGlobalCodesift) }))
    .filter((row): row is ProcessRow & { reason: string } => row.reason !== null);

  const beforeMb = targets.reduce((sum, row) => sum + row.rssKb, 0) / 1024;
  const killed: Array<ProcessRow & { reason: string }> = [];
  const failed: Array<ProcessRow & { reason: string; error: string }> = [];

  if (!dryRun) {
    for (const row of targets) {
      try {
        const current = currentProcessCommand(row.pid);
        if (current !== row.command || classifyCleanupTarget(current, includeGlobalCodesift) !== row.reason) {
          throw new Error("process identity changed before kill");
        }
        process.kill(row.pid, "SIGKILL");
        killed.push(row);
      } catch (err) {
        failed.push({ ...row, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const byReason: Record<string, { count: number; rss_mb: number }> = {};
  for (const row of targets) {
    byReason[row.reason] ??= { count: 0, rss_mb: 0 };
    byReason[row.reason]!.count += 1;
    byReason[row.reason]!.rss_mb += row.rssKb / 1024;
  }
  for (const value of Object.values(byReason)) {
    value.rss_mb = Number(value.rss_mb.toFixed(1));
  }

  output({
    dry_run: dryRun,
    include_global_codesift: includeGlobalCodesift,
    matched: targets.length,
    killed: dryRun ? 0 : killed.length,
    failed: failed.length,
    matched_rss_mb: Number(beforeMb.toFixed(1)),
    by_reason: byReason,
    failed_pids: failed.map((row) => ({ pid: row.pid, reason: row.reason, error: row.error })),
  }, flags);
}

export { handlePrune, handleCleanupProcesses };
