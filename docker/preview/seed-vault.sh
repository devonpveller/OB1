#!/bin/sh
# One-shot seeder for the ob-preview vault (run by the preview-seed service).
#
# WHY THIS EXISTS
#   The preview-wiki volume starts EMPTY. Nothing else in the preview stack
#   fills it: the wiki compiler is not part of this stack, so without this the
#   viewer sits in "waiting for first compile..." for 10 minutes and there is
#   no page to open at :8099 at all. The seed vault lives in ./preview/seed.
#
#   The second half is just as load-bearing. The workbench's ensureVaultRepo()
#   runs a bare `git init -q` on first boot: default branch name, and NO
#   commit. HEAD is therefore unborn, so `git show HEAD:<file>` fails and with
#   it every note history / revert / diff path, and Quartz warns
#   "isn't yet tracked by git, dates will be inaccurate" for every page. A real
#   `git init -b main` plus a commit of the seed is what makes the vault a
#   working git-backed vault instead of a directory with a .git in it.
#
# IDEMPOTENT: safe to re-run on every `up`. Only an unseeded vault is filled,
# only a repo without HEAD is initialised, and the commit is skipped when there
# is nothing staged.
set -e

VAULT=/wiki
SEED=/seed

mkdir -p "$VAULT"

# /wiki is a volume mount, so git refuses to look through the mount boundary
# for a parent repo without this (and refuses the root-owned tree as "dubious
# ownership" under newer git).
export GIT_DISCOVERY_ACROSS_FILESYSTEM=1
git config --global --add safe.directory "$VAULT" 2>/dev/null || true

if [ -e "$VAULT/index.md" ]; then
  echo "[preview-seed] vault already seeded (index.md present) - leaving content alone"
else
  echo "[preview-seed] seeding vault from $SEED"
  cp -a "$SEED/." "$VAULT/"
fi

# A .git without HEAD is not a repository - that is the state a half-made or
# template-only .git leaves behind, and every git command below would fail on
# it. Replace it rather than trying to repair it: this volume is throwaway.
if [ ! -f "$VAULT/.git/HEAD" ]; then
  echo "[preview-seed] no usable .git (no HEAD) - creating a real repo on main"
  rm -rf "$VAULT/.git"
  git init -q -b main "$VAULT"
fi

cd "$VAULT"
git config user.email "preview-seed@openbrain.local"
git config user.name "preview seed"

git add -A
if git diff --cached --quiet; then
  echo "[preview-seed] nothing to commit"
else
  git commit -q -m "seed preview vault"
  echo "[preview-seed] committed the seed vault"
fi

echo "[preview-seed] branch: $(git rev-parse --abbrev-ref HEAD)  HEAD: $(git rev-parse --short HEAD)"
echo "[preview-seed] pages: $(find "$VAULT" -name '*.md' -not -path '*/.git/*' | wc -l)"
