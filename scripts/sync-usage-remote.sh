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

for host in "${HOSTS[@]}"; do
  # --partial + tmp suffix so stats readers never see a half-copied file.
  if rsync -az --timeout=20 "$host:~/.codesift/usage.jsonl" "$DEST/$host.jsonl.tmp" 2>/dev/null; then
    mv "$DEST/$host.jsonl.tmp" "$DEST/$host.jsonl"
    echo "synced $host ($(wc -l < "$DEST/$host.jsonl" | tr -d ' ') entries)"
  else
    rm -f "$DEST/$host.jsonl.tmp"
    echo "skip $host (unreachable or no usage.jsonl)" >&2
  fi
done
