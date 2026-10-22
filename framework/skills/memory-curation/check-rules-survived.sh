#!/usr/bin/env bash
# Check that every rule line from before consolidation is still in rules.md.
# Usage: bash check-rules-survived.sh <snapshot> <rules.md>
# Exit 0: every line still present word for word.
# Exit 1: lines below are no longer present verbatim; each must be shown merged
#         into a current line, or put back.
# Exit 2: check could not run (missing/empty file, grep error). Fail closed:
#         abort consolidation, restore rules.md from the snapshot, commit nothing.
before="${1:-}"; after="${2:-}"
fail() { echo "RULES CHECK FAILED: $*"; exit 2; }
[ -n "$before" ] && [ -n "$after" ] || fail "usage: check-rules-survived.sh <snapshot> <rules.md>"
[ -s "$before" ] || fail "snapshot $before missing or empty"
[ -f "$after" ] || fail "$after is missing"
[ -s "$after" ] || fail "$after is empty"
missing="$(grep -vxF -f "$after" "$before")"; rc=$?
[ "$rc" -le 1 ] || fail "grep error (exit $rc)"
missing="$(printf '%s\n' "$missing" | grep -v '^[[:space:]]*$' || true)"
if [ -n "$missing" ]; then
	echo "RULES CHECK: lines no longer present verbatim (show each merged, or put it back):"
	printf '%s\n' "$missing"
	exit 1
fi
echo "RULES CHECK OK: every prior rule line is present"
