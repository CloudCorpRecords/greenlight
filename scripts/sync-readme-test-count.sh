#!/usr/bin/env bash
# scripts/sync-readme-test-count.sh (v0.17.1, item 27): regenerate the
# README test count from an actual suite run instead of hand-editing it.
# The hand-written number went stale twice (965 vs 973, then 994 vs
# 1026) because nothing enforced the refresh. The release checklist
# now requires `npm run readme:count` after the suite passes; the
# packaging test asserts the checklist documents this step, and this
# script refuses to update the README when the suite is red.
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(npx tsx --test test/*.test.ts 2>&1 || true)"
count="$(printf '%s\n' "$out" | grep -E '^ℹ tests ' | tail -1 | awk '{print $3}' || true)"
fails="$(printf '%s\n' "$out" | grep -E '^ℹ fail ' | tail -1 | awk '{print $3}' || true)"
if [ -z "$count" ]; then
  echo "could not read a test count from the suite output; refusing to update README" >&2
  exit 1
fi
if [ "$fails" != "0" ]; then
  echo "suite has $fails failing tests; refusing to update README" >&2
  exit 1
fi
perl -pi -e "s/^\* \K\d+(?= tests, all passing,)/${count}/" README.md
echo "README test count set to ${count}"
