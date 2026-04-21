#!/usr/bin/env bash
set -euo pipefail

# verify-prototype-fixture.sh
#
# Checks that the committed fixture is byte-identical to the prototype source.
#
# Usage:
#   bash scripts/verify-prototype-fixture.sh
#         — uses default paths (prototype vs fixture)
#   bash scripts/verify-prototype-fixture.sh <PROTOTYPE_PATH> <FIXTURE_PATH>
#         — compares the two explicit paths
#
# Exit codes:
#   0 — hashes match (fixture is current)
#   1 — hashes differ (drift detected)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ $# -eq 0 ]]; then
  PROTOTYPE="${REPO_ROOT}/.codesift/wiki/history.md"
  FIXTURE="${REPO_ROOT}/tests/fixtures/journal/prototype-history.md"
elif [[ $# -eq 2 ]]; then
  PROTOTYPE="$1"
  FIXTURE="$2"
else
  echo "Usage: $0 [PROTOTYPE_PATH FIXTURE_PATH]" >&2
  exit 2
fi

if [[ ! -f "${PROTOTYPE}" ]]; then
  echo "ERROR: prototype file not found: ${PROTOTYPE}" >&2
  exit 2
fi

if [[ ! -f "${FIXTURE}" ]]; then
  echo "ERROR: fixture file not found: ${FIXTURE}" >&2
  exit 2
fi

PROTO_HASH="$(shasum -a 256 "${PROTOTYPE}" | awk '{print $1}')"
FIX_HASH="$(shasum -a 256 "${FIXTURE}" | awk '{print $1}')"

if [[ "${PROTO_HASH}" == "${FIX_HASH}" ]]; then
  echo "OK: hashes match (${PROTO_HASH})"
  exit 0
else
  echo "SHA mismatch: prototype=${PROTO_HASH}  fixture=${FIX_HASH}" >&2
  exit 1
fi
