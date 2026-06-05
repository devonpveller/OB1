#!/bin/sh
# One-shot preview migration to the operator-chosen notes layout (#4):
#   content/notebooks/<nb>/  = AI-generated   |  notes/notebooks/<nb>/ = user
cd /wiki || exit 1
mkdir -p content/notebooks/project-aurora notes/notebooks/project-aurora
for f in ai/project-aurora/*.md; do
  [ -e "$f" ] && git mv "$f" content/notebooks/project-aurora/
done
[ -e notes/project-aurora/idea.md ] && git mv notes/project-aurora/idea.md notes/notebooks/project-aurora/idea.md
rmdir ai/project-aurora ai notes/project-aurora 2>/dev/null
git add -A
git commit -q -m "restructure notes layout (#4): content/notebooks + notes/notebooks"
echo "== content/notebooks (ai) =="
find content/notebooks -name '*.md'
echo "== notes/notebooks (user) =="
find notes/notebooks -name '*.md'
