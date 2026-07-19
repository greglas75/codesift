#!/usr/bin/env bash
# Pull collected telemetry from the coding-vps collector to the Mac for the
# weekly report (spec §6). Mirrors scripts/sync-usage-remote.sh. Read-only rsync.
#
# Usage:  ./scripts/telemetry-pull.sh [ssh-host]     (default: root@100.110.133.83)
# Cron (Mondays 06:00, before retro-mine):
#   0 6 * * 1 /path/to/telemetry-pull.sh && node /path/to/telemetry-report.mjs > ~/.zuvo/mining/telemetry-weekly.md
set -euo pipefail

HOST="${1:-root@100.110.133.83}"
REMOTE="${CODESIFT_COLLECTOR_REMOTE:-/home/gha/telemetry-collector/data/}"
DEST="${CODESIFT_DATA_DIR:-$HOME/.codesift}/telemetry-collected/"
mkdir -p "$DEST"

if rsync -az --timeout=30 "$HOST:$REMOTE" "$DEST"; then
  echo "pulled telemetry → $DEST"
  ls -1 "$DEST"/codesift/ 2>/dev/null | tail -3 || true
else
  echo "skip: $HOST unreachable or no data" >&2
  exit 1
fi
