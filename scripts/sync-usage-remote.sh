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
# --both / CODESIFT_SYNC_BOTH=1 also PUSHES this machine's log to each peer, as
# <peer>:~/.codesift/usage-remote/<our host-id>.jsonl — so both machines can answer
# "what did this fleet do", not just the one that happens to run the cron.
#
# Pull-only is the default because it needs nothing from the peer. Push exists because
# a pull cannot be symmetric here: a workstation behind no sshd (measured 2026-10-01:
# the Mac refuses :22, so the sessions host cannot reach it) can only ever initiate.
# One scheduler on the machine that CAN reach the other does both directions.
#
# It writes ONLY into the peer's usage-remote/, never its usage.jsonl, and refuses a
# peer whose host-id equals ours — a host must not appear in its own remote dir, or
# every reader counts those calls twice.
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

BOTH="${CODESIFT_SYNC_BOTH:-0}"
ARGS=()
for a in "$@"; do
  case "$a" in
    --both) BOTH=1 ;;
    --pull-only) BOTH=0 ;;
    *) ARGS+=("$a") ;;
  esac
done

HOSTS=("${ARGS[@]+${ARGS[@]}}")
if [ ${#HOSTS[@]} -eq 0 ] && [ -n "${CODESIFT_SYNC_HOSTS:-}" ]; then
  read -ra HOSTS <<< "$CODESIFT_SYNC_HOSTS"
fi
if [ ${#HOSTS[@]} -eq 0 ]; then
  echo "usage: $0 <ssh-host> [<ssh-host> ...]  (or set CODESIFT_SYNC_HOSTS)" >&2
  exit 1
fi

DATA_DIR="${CODESIFT_DATA_DIR:-$HOME/.codesift}"
DEST="$DATA_DIR/usage-remote"
mkdir -p "$DEST"

# Our identity for the pushed filename. `host-id` is the tag the entries themselves carry
# (resolveHostTag freezes it there precisely because os.hostname() drifts on macOS); the
# hostname fallback is for a data dir that has never written a usage entry.
SELF_ID="$(cat "$DATA_DIR/host-id" 2>/dev/null || true)"
[ -n "$SELF_ID" ] || SELF_ID="$(hostname -s 2>/dev/null || hostname)"

push_to_peer() {
  local host="$1" src="$DATA_DIR/usage.jsonl"
  if [ ! -s "$src" ]; then
    echo "skip push -> $host (no local usage.jsonl)" >&2
    return 0
  fi
  # The peer must not end up with its own log in its remote dir: that double-counts every
  # call it already reads locally. Comparing host-ids, not ssh aliases — the same machine
  # is reachable under several names.
  local peer_id
  peer_id="$(ssh -o ConnectTimeout=15 -o BatchMode=yes "$host" 'cat ${CODESIFT_DATA_DIR:-$HOME/.codesift}/host-id 2>/dev/null' 2>/dev/null | tr -d "[:space:]")" || peer_id=""
  if [ -n "$peer_id" ] && [ "$peer_id" = "$SELF_ID" ]; then
    echo "skip push -> $host (same host-id \"$SELF_ID\" — that would double-count)" >&2
    return 0
  fi
  # tmp + mv ON THE PEER, so its readers never parse a half-copied file.
  if rsync -az --timeout=20 "$src" "$host:.codesift/usage-remote/$SELF_ID.jsonl.tmp" 2>/dev/null \
     && ssh -o ConnectTimeout=15 -o BatchMode=yes "$host" \
          "mv ~/.codesift/usage-remote/$SELF_ID.jsonl.tmp ~/.codesift/usage-remote/$SELF_ID.jsonl" 2>/dev/null; then
    echo "pushed $SELF_ID -> $host ($(wc -l < "$src" | tr -d ' ') entries)"
  else
    ssh -o ConnectTimeout=10 -o BatchMode=yes "$host" "rm -f ~/.codesift/usage-remote/$SELF_ID.jsonl.tmp" 2>/dev/null || true
    echo "skip push -> $host (unreachable or no usage-remote dir)" >&2
  fi
}

for spec in "${HOSTS[@]}"; do
  host="${spec%%:*}"
  glob="${spec#*:}"
  if [ "$BOTH" = "1" ]; then
    ssh -o ConnectTimeout=15 -o BatchMode=yes "$host" 'mkdir -p ${CODESIFT_DATA_DIR:-$HOME/.codesift}/usage-remote' 2>/dev/null || true
    push_to_peer "$host"
  fi
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
