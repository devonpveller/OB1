#!/usr/bin/env node
/**
 * slug-vault - rw-p1a-deploy-prep (NA4-1, RV-1): add the legacy-note
 * fixtures whose FILE NAMES Quartz slugifies, and the paths Quartz never
 * builds, to the disposable vault (p1a-env.sh vault, after the committed
 * fixture vault is copied). Written at run time inside the container because
 * a Windows checkout cannot hold "q?x.md" (and so the operator's checkout
 * never carries such names).
 *
 *   node slug-vault.mjs [vault]        (default $WIKI_GIT_DIR, else /wiki)
 *
 * Pages (Quartz builds each; the URL it builds in brackets):
 *   notes/slug-names/sp ace.md       [/notes/slug-names/sp-ace]   space
 *   notes/slug-names/pv.1.md         [/notes/slug-names/pv.1]     a dot in the stem
 *   notes/slug-names/a&b.md          [/notes/slug-names/a-and-b]  &   (tagged fixture-tag)
 *   notes/slug-names/q?x.md          [/notes/slug-names/qx]       ?
 *   notes/slug-names/h#t.md          [/notes/slug-names/ht]       #
 *   notes/slug-names/50%.md          [/notes/slug-names/50-percent] %
 *   notes/slug-names/up.md + up/inner.md  a note and a folder of one name
 *   notes/slug-names/deep folder/sub dir/leaf note.md   a deep folder with spaces
 *   notes/private/kept.md            [/notes/private/kept] - Quartz's ignore
 *                                    patterns are root-anchored: this IS a page
 * Hand-written wikilinks (RV-1): sp ace links [[tool-fixture-db]] and
 * [[nested-note]] by BASENAME - the repair pass (and the backfill) resolve
 * them to content/tool/tool-fixture-db and notes/fixture-folder/nested-note.
 * Not pages (Quartz skips them; the walk must too):
 *   private/secret.md, templates/tpl.md, .obsidian/o.md,
 *   notes/.hidden/h.md, notes/.dot-note.md
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const VAULT = process.argv[2] || process.env.WIKI_GIT_DIR || "/wiki";
export const SLUG_FILES = {
  "notes/slug-names/sp ace.md":
    "# Space in the name\n\nA legacy note whose file name has a space. Links: [[fixture-note]], [[a&b]], [[pv.1]], [[up]],\n" +
    "[[tool-fixture-db]] and [[nested-note]] (basenames the repair pass resolves).\n",
  "notes/slug-names/pv.1.md": "# Dotted name\n\nBack to [[sp ace]].\n",
  "notes/slug-names/a&b.md": "---\ntitle: \"Ampersand note\"\ntags: [fixture-tag]\n---\n# Ampersand\n\nSee [[q?x]].\n",
  "notes/slug-names/q?x.md": "# Question mark\n\nA name with a question mark.\n",
  "notes/slug-names/h#t.md": "# Hash\n\nA name with a hash.\n",
  "notes/slug-names/50%.md": "# Percent\n\nA name with a percent sign.\n",
  "notes/slug-names/up.md": "---\ntitle: \"Up page\"\n---\n# Up\n\nA note with the name of a folder beside it.\n",
  "notes/slug-names/up/inner.md": "# Inner\n\nInside the folder that shares a name with [[up]].\n",
  "notes/slug-names/deep folder/sub dir/leaf note.md": "# Leaf note\n\nDeep inside folders with spaces. Up: [[sp ace]].\n",
  "notes/private/kept.md": "# Nested private folder\n\nQuartz builds this page: its ignore patterns match at the vault root only.\n",
  // not pages
  "private/secret.md": "# SECRET-FIXTURE-MARKER\n",
  "templates/tpl.md": "# TEMPLATE-FIXTURE-MARKER {{title}}\n",
  ".obsidian/o.md": "# OBSIDIAN-FIXTURE-MARKER\n",
  "notes/.hidden/h.md": "# HIDDEN-DIR-FIXTURE-MARKER\n",
  "notes/.dot-note.md": "# DOT-FILE-FIXTURE-MARKER\n",
};

if (process.argv[1] && process.argv[1].endsWith("slug-vault.mjs")) {
  for (const [rel, text] of Object.entries(SLUG_FILES)) {
    mkdirSync(dirname(join(VAULT, rel)), { recursive: true });
    writeFileSync(join(VAULT, rel), text);
  }
  console.log(`[slug-vault] ${Object.keys(SLUG_FILES).length} file(s) written under ${VAULT}`);
}
