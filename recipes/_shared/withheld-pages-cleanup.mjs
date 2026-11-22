#!/usr/bin/env node
/**
 * withheld-pages-cleanup - move the page files a privacy guard refused out of the served vault, into a backup folder,
 * and back again (research-workbench rw-wiki-guarded-pages).
 *
 * Before this change a refused page (slots 380 / 390 / 430 / 440 RAISE 42501 for a note; they withhold any other page
 * silently) kept its vault file: the compile wrote the file first, and the refusal failed the row write's whole batch.
 * The writer now leaves such files out as it meets them; this moves out the ones already there. Run it INSIDE the
 * openbrain-wiki container (the vault read-write, OPEN_BRAIN_URL set), after the new wiki-service image is deployed:
 *
 *   node /recipes/_shared/withheld-pages-cleanup.mjs --plan
 *   node /recipes/_shared/withheld-pages-cleanup.mjs --apply [--backup /wiki/.withheld-backup-<stamp>]
 *   node /recipes/_shared/withheld-pages-cleanup.mjs --revert --backup <the folder --apply printed>
 *
 * --plan    reads only: the reconcile's drift and how many recorded withheld pages still have a file. Writes nothing.
 * --apply   1. the reconcile's repair pass (the new writer: each missing / stale row written on its own chunk, a refused
 *              or withheld one RECORDED as withheld - slug hash only - instead of failing the batch); the rows that do
 *              land are the ones the viewer's repair would write anyway
 *           2. every page file whose slug is recorded withheld MOVES to the backup folder (same relative path), with
 *              manifest.json (the moved paths) and the withheld record as it was before step 1 (record.before.json)
 *           3. the reconcile again (check only)
 * --revert  moves every file of the manifest back (a path that exists again is left as it is, and counted) and puts the
 *           withheld record back as it was before --apply. Rows step 1 wrote stay (they are the files' own rows).
 * Output: COUNTS only - never a slug, a title or page text. The backup folder holds the files and their paths; it is a
 * dot-folder of the vault (never walked, served or committed: vault-gitignore.mjs) unless --backup names another place.
 * Exit: 0 done, 1 drift left after --apply (counts printed), 2 cannot run.
 */
import fs from "node:fs";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { reconcile, listFiles } from "./reconcile-wiki-pages.mjs";
import { readWithheldRecord, withheldFileFor, slugHash } from "./wiki-pages.mjs";

const say = (m) => console.log(`[withheld-cleanup] ${m}`);
const counts = (r) => `drift ${r.drift} (${r.missing.length} missing, ${r.stale.length} stale, ${r.empty.length} empty, ${r.orphan.length} orphan, ${r.failed.length} failed); withheld ${r.withheld || 0}`;

export async function plan({ vault }) {
  const r = await reconcile({ vault, repair: false, log: () => {} });
  const rec = readWithheldRecord(withheldFileFor(vault));
  const files = await listFiles(vault);
  const present = [...files.keys()].filter((s) => rec[slugHash(s)]).length;
  say(`plan: ${counts(r)}; ${Object.keys(rec).length} recorded withheld page(s), ${present} with a file still in the vault`);
  return { report: r, recorded: Object.keys(rec).length, present };
}

export async function apply({ vault, backup }) {
  const wfile = withheldFileFor(vault);
  fs.mkdirSync(backup, { recursive: true });
  if (fs.readdirSync(backup).length) throw new Error("the backup folder is not empty");
  fs.writeFileSync(nodePath.join(backup, "record.before.json"), JSON.stringify({ existed: fs.existsSync(wfile), pages: readWithheldRecord(wfile) }, null, 2) + "\n");
  const r1 = await reconcile({ vault, repair: true, log: () => {} });
  say(`repair: ${(r1.repaired || []).length} row(s) written, ${(r1.repairFailed || []).length} failed; after: ${counts(r1.after || r1)}`);
  const rec = readWithheldRecord(wfile);
  const files = await listFiles(vault);
  const moved = [];
  for (const [slug, f] of files) {
    if (!rec[slugHash(slug)]) continue;
    const from = nodePath.join(vault, f.rel);
    const to = nodePath.join(backup, "files", f.rel);
    fs.mkdirSync(nodePath.dirname(to), { recursive: true });
    try { fs.renameSync(from, to); } catch (e) {
      if (e?.code !== "EXDEV") throw e;
      fs.copyFileSync(from, to); fs.unlinkSync(from);
    }
    moved.push(f.rel);
  }
  fs.writeFileSync(nodePath.join(backup, "manifest.json"), JSON.stringify({ at: new Date().toISOString(), vault, moved }, null, 2) + "\n");
  const r2 = await reconcile({ vault, repair: false, log: () => {} });
  say(`apply: ${moved.length} refused page file(s) moved to the backup folder ${backup}; reconcile: ${counts(r2)}`);
  return { moved: moved.length, report: r2 };
}

export async function revert({ vault, backup }) {
  const man = JSON.parse(fs.readFileSync(nodePath.join(backup, "manifest.json"), "utf8"));
  const before = JSON.parse(fs.readFileSync(nodePath.join(backup, "record.before.json"), "utf8"));
  let back = 0, kept = 0, gone = 0;
  for (const rel of man.moved || []) {
    const from = nodePath.join(backup, "files", rel);
    const to = nodePath.join(vault, rel);
    if (!nodePath.resolve(to).startsWith(nodePath.resolve(vault) + nodePath.sep)) { gone++; continue; }
    if (!fs.existsSync(from)) { gone++; continue; }
    if (fs.existsSync(to)) { kept++; continue; }
    fs.mkdirSync(nodePath.dirname(to), { recursive: true });
    try { fs.renameSync(from, to); } catch (e) { if (e?.code !== "EXDEV") throw e; fs.copyFileSync(from, to); fs.unlinkSync(from); }
    back++;
  }
  const wfile = withheldFileFor(vault);
  if (before.existed) {
    const tmp = `${wfile}.tmp-revert-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ pages: before.pages || {} }, null, 2) + "\n");
    fs.renameSync(tmp, wfile);
  } else {
    try { fs.unlinkSync(wfile); } catch { /* none */ }
  }
  const r = await reconcile({ vault, repair: false, log: () => {} });
  say(`revert: ${back} file(s) put back, ${kept} left (a file is there again), ${gone} missing from the backup; withheld record restored (${Object.keys(before.pages || {}).length} page(s)); reconcile: ${counts(r)}`);
  return { back, kept, gone, report: r };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const vault = opt("--vault") || process.env.WIKI_GIT_DIR || "/wiki";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "Z");
  const backup = opt("--backup") || nodePath.join(vault, `.withheld-backup-${stamp}`);
  const run = args.includes("--apply") ? () => apply({ vault, backup })
    : args.includes("--revert") ? () => { if (!opt("--backup")) throw new Error("--revert needs --backup <folder>"); return revert({ vault, backup }); }
    : () => plan({ vault });
  run().then((r) => { process.exitCode = args.includes("--apply") && r.report.drift > 0 ? 1 : 0; })
    .catch((e) => { console.error(`[withheld-cleanup] CANNOT RUN: ${String(e?.message || e).slice(0, 200)}`); process.exitCode = 2; });
}
