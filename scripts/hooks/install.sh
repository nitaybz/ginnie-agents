#!/bin/bash
# Point this clone's hooks dir at scripts/hooks so everyone runs the same
# hooks without symlink dance. Idempotent; run once per fresh clone.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

git config core.hooksPath scripts/hooks
chmod +x scripts/hooks/commit-msg

# Remove stale pre-commit from older clones. The memory hook is now a
# commit-msg hook (needs access to the message for the memory-consolidate:
# opt-in). A leftover pre-commit would silently do nothing.
rm -f scripts/hooks/pre-commit

echo "✓ Git hooks installed — core.hooksPath → scripts/hooks"
echo "  Memory invariants now enforced:"
echo "    - rules.md     ≤ 200 lines"
echo "    - playbook.md  ≤ 300 lines"
echo "    - episodes/*   append-only (bypass: commit msg starts with 'memory-consolidate:')"
