#!/bin/bash
HOOK_NAME=$(basename "$0")
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
LOCAL_HOOK="$PROJECT_ROOT/.git/hooks/$HOOK_NAME"
if [ -x "$LOCAL_HOOK" ]; then
  exec "$LOCAL_HOOK" "$@"
fi
