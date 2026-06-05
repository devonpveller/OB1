#!/bin/sh
cd /wiki || exit 1
# The singular content/notebook/ tree is retired — the hub now lives at
# content/notebooks/<slug>/<slug>.md (added via docker cp before this runs).
rm -rf content/notebook content/notebook.md
git add -A
git commit -q -m "unify notebook hub into content/notebooks/<slug>/ (fix duplication)"
echo "== content/notebook (should be empty/gone) =="
ls content/notebook 2>&1 || echo "(gone)"
echo "== content/notebooks tree =="
find content/notebooks -type f -name '*.md'
