#!/usr/bin/env bash
# Pull CodeSift usage logs from remote machines into ~/.codesift/usage-remote/.
# Each host's log lands as usage-remote/<host>.jsonl; usage_stats and the
# dashboard merge these with the local log automatically (entries without a
# host field inherit the filename stem as their host tag).
#
# Usage:
#   ./scripts/sync-usage-remote.sh vps1 [vps2 ...]     # ssh-config host aliases
#   CODESIFT_SYNC_HOSTS="vps1 vps2" ./scripts/sync-usage-remote.sh
#
# Concat mode — for hosts where CodeSift runs in many containers/workspaces,
# each with its own ~/.codesift (e.g. thepopebot: one per workspace bind-mount).
# Append :<remote-glob> to the host; all matching logs are concatenated into
# one <host>.jsonl. Entries without a host field inherit "<host>" at read time.
#   ./scripts/sync-usage-remote.sh 'coding-vps:/root/bot/data/workspaces/*/.codesift/usage.jsonl'
#
# Cron (every 30 min):
#   */30 * * * * /path/to/sync-usage-remote.sh vps1 >/dev/null 2>&1
set -euo pipefail

HOSTS=("$@")
if [ ${#HOSTS[@]} -eq 0 ] && [ -n "${CODESIFT_SYNC_HOSTS:-}" ]; then
  read -ra HOSTS <<< "$CODESIFT_SYNC_HOSTS"
fi
if [ ${#HOSTS[@]} -eq 0 ]; then
  echo "usage: $0 <ssh-host> [<ssh-host> ...]  (or set CODESIFT_SYNC_HOSTS)" >&2
  exit 1
fi

DEST="${CODESIFT_DATA_DIR:-$HOME/.codesift}/usage-remote"
mkdir -p "$DEST"

for spec in "${HOSTS[@]}"; do
  host="${spec%%:*}"
  glob="${spec#*:}"
  # tmp + rename so stats readers never see a half-copied file.
  if [ "$glob" != "$spec" ]; then
    # concat mode: host:glob — gather every per-workspace log in one pass
    if ssh -o ConnectTimeout=15 -o BatchMode=yes "$host" "cat $glob 2>/dev/null" > "$DEST/$host.jsonl.tmp" 2>/dev/null \
       && [ -s "$DEST/$host.jsonl.tmp" ]; then
      mv "$DEST/$host.jsonl.tmp" "$DEST/$host.jsonl"
      echo "synced $host concat ($(wc -l < "$DEST/$host.jsonl" | tr -d ' ') entries)"
    else
      rm -f "$DEST/$host.jsonl.tmp"
      echo "skip $host (unreachable or glob matched nothing)" >&2
    fi
  elif rsync -az --timeout=20 "$host:~/.codesift/usage.jsonl" "$DEST/$host.jsonl.tmp" 2>/dev/null; then
    mv "$DEST/$host.jsonl.tmp" "$DEST/$host.jsonl"
    echo "synced $host ($(wc -l < "$DEST/$host.jsonl" | tr -d ' ') entries)"
  else
    rm -f "$DEST/$host.jsonl.tmp"
    echo "skip $host (unreachable or no usage.jsonl)" >&2
  fi
done
