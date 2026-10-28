/**
 * staged-sweep - remove the hidden staged files a HARD-KILLED compile left in
 * the vault (research-workbench P1c; rw-p1b-ready review R-1).
 *
 * writeWikiPage (recipes/_shared/wiki-pages.mjs) stages an update as a hidden
 * sibling ".<name>.wp-staged-<pid>" and renames it into place once the page's
 * row has landed. A process killed between the two leaves the staged file
 * behind: nothing reads it (the vault walk and Quartz skip dot-files) but the
 * service's `git add -A` would commit it. The vault .gitignore lists the
 * pattern (vault-gitignore.mjs), and this sweep deletes the leftovers once, at
 * the service's start - when no compile child (the only writers) can be
 * running, because every compile is a child of this process.
 *
 * Only names matching STAGED are touched; .git/ is never entered.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export const STAGED = /^\..+\.wp-staged-\d+$/;

/** -> [relative paths removed] */
export async function sweepStaged(root) {
  const removed = [];
  const walk = async (dir, rel) => {
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), r);
      else if (e.isFile() && STAGED.test(e.name)) {
        await rm(join(dir, e.name), { force: true });
        removed.push(r);
      }
    }
  };
  await walk(root, "");
  return removed;
}
