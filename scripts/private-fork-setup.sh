#!/usr/bin/env bash
# scripts/private-fork-setup.sh — local safeguards for people running a
# PUBLIC fork of ginnie-agents, so their private agents (real names, real
# business context, real memory) can never be accidentally committed.
#
# Background: the framework's committed .gitignore deliberately does NOT
# ignore agents/*/, because a PRIVATE fork is expected to version its
# agents' memory (that's what .gitattributes merge=union and the
# commit-msg memory-cap hook are for). This script does not change that.
# It adds a second, LOCAL-ONLY layer of protection for people whose fork
# is public, using .git/info/exclude and the skip-worktree bit — neither
# of which is part of the repo's history, so this script must be run
# once per clone, on every machine.
#
# Idempotent; safe to run repeatedly.
# Never destructive: never deletes a file, never runs `git rm`, never
# touches history. If private content is already tracked by git, this
# script stops and tells you exactly which paths — removing already
# committed content is a history-rewrite decision only you can make.
#
# Run from anywhere; the script anchors to its own location.

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

changed=0
blocked=0

PASS() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
INFO() { printf "  \033[36mi\033[0m %s\n" "$1"; }
WARN() { printf "  \033[33m!\033[0m %s\n" "$1"; [ -n "${2:-}" ] && printf "      → %s\n" "$2"; }
FAIL() { printf "  \033[31m✗\033[0m %s\n" "$1"; [ -n "${2:-}" ] && printf "      → %s\n" "$2"; }
SECTION() { printf "\n\033[1m%s\033[0m\n" "$1"; }

if [ ! -d .git ]; then
  FAIL "not a git repository" "Expected a .git/ directory at $REPO"
  exit 1
fi

# ─── 1. Refuse to proceed if private content is already tracked ───────────
# This must run BEFORE anything else: excludes and skip-worktree only hide
# untracked/unstaged state going forward, they do nothing for content that
# is already committed. If that's the case, only a history rewrite (which
# this script will never attempt) fixes it — the person has to decide.
SECTION "Checking for private content already committed"

already_tracked=()

while IFS= read -r f; do
  base="$(basename "$f")"
  [ "$base" = ".gitkeep" ] && continue
  already_tracked+=("$f")
done < <(git ls-files -- 'agents/*/*' 2>/dev/null)

while IFS= read -r f; do
  already_tracked+=("$f")
done < <(git ls-files -- 'agents/._*' 'shared/foundation.md' 'docs/*' 2>/dev/null)

if [ "${#already_tracked[@]}" -gt 0 ]; then
  FAIL "private content is already tracked by git — cannot fix this automatically"
  for f in "${already_tracked[@]}"; do
    printf "      %s\n" "$f"
  done
  WARN "removing already-committed content rewrites history" \
    "That decision — and picking a safe rewrite method — is yours to make. This script will not attempt it."
  blocked=1
else
  PASS "no private content found already tracked by git"
fi

if [ "$blocked" -eq 1 ]; then
  SECTION "Result"
  FAIL "stopped before making any changes" "Resolve the tracked paths above, then re-run this script."
  exit 1
fi

# ─── 2. Local excludes (.git/info/exclude) ─────────────────────────────────
# Same category of content the committed .gitignore intentionally leaves
# alone: agents/*/ operational state, docs/, and skill/config overlays that
# only make sense for this particular install.
SECTION "Local excludes (.git/info/exclude)"

EXCLUDE_FILE=".git/info/exclude"
mkdir -p .git/info
touch "$EXCLUDE_FILE"

PATTERNS=(
  "agents/*/"
  "shared/foundation.md"
  "docs/"
  "agents/._*"
)

to_add=()
for p in "${PATTERNS[@]}"; do
  if grep -qxF "$p" "$EXCLUDE_FILE"; then
    PASS "already excluded: $p"
  else
    to_add+=("$p")
  fi
done

if [ "${#to_add[@]}" -gt 0 ]; then
  {
    echo ""
    echo "# Private-fork safeguards (scripts/private-fork-setup.sh)"
    for p in "${to_add[@]}"; do
      echo "$p"
    done
  } >> "$EXCLUDE_FILE"
  for p in "${to_add[@]}"; do
    PASS "excluded: $p (added)"
  done
  changed=1
fi

# ─── 3. shared/known-users.json — skip-worktree ────────────────────────────
# The committed copy is an empty {"users": {}} template. A public-fork
# install's working copy holds real names, emails and roles. skip-worktree
# tells git to stop diffing/staging this file so those edits never show up
# in `git status` or `git add`.
SECTION "shared/known-users.json (skip-worktree)"

KU="shared/known-users.json"
if [ ! -f "$KU" ]; then
  WARN "$KU not found" "Nothing to protect — expected in a normal clone."
elif ! git ls-files --error-unmatch -- "$KU" >/dev/null 2>&1; then
  WARN "$KU exists but is not tracked by git" "Skip-worktree only applies to tracked files; nothing to do."
else
  flag="$(git ls-files -v -- "$KU" | awk '{print substr($0,1,1)}')"
  if [ "$flag" = "S" ]; then
    PASS "$KU already marked skip-worktree"
  else
    if ! git diff --cached --quiet -- "$KU" 2>/dev/null; then
      WARN "$KU has staged changes that differ from the committed template" \
        "Review with: git diff --cached -- $KU (marking skip-worktree will stop these from showing in git status)"
    fi
    git update-index --skip-worktree "$KU"
    PASS "$KU marked skip-worktree (added)"
    changed=1
  fi
fi

# ─── 4. Report whether origin looks public (informational only) ───────────
SECTION "Origin visibility"

if ! command -v gh >/dev/null 2>&1; then
  INFO "gh CLI not found — could not check whether origin is public. Check manually."
elif ! git remote get-url origin >/dev/null 2>&1; then
  INFO "no 'origin' remote configured — could not check visibility."
else
  visibility="$(gh repo view --json visibility --jq '.visibility' 2>/dev/null || true)"
  if [ -z "$visibility" ]; then
    INFO "gh repo view failed — could not check whether origin is public. Check manually."
  elif [ "$visibility" = "PUBLIC" ]; then
    WARN "origin is PUBLIC" "Make sure you've run this script on every machine that clones this fork."
  else
    PASS "origin visibility: $visibility"
  fi
fi

# ─── Summary ────────────────────────────────────────────────────────────
SECTION "Result"

if [ "$changed" -eq 1 ]; then
  PASS "protections applied — see changes above"
else
  PASS "everything already protected — nothing to do"
fi

INFO "these protections are local to this clone ($REPO) and do not travel with git."
INFO "run this script once on every machine that clones this fork."

exit 0
