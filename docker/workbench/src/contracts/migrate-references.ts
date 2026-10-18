// Migrate every legacy note's references into reference records (research-workbench P2a).
//
//   deno run --allow-net --allow-env --allow-read src/contracts/migrate-references.ts [--dry-run]
//
// Run INSIDE the workbench container (it reads the vault at WIKI_GIT_DIR and the database the
// workbench uses), after init-references.sql is applied. It reads note files and never writes
// them. One transaction per note:
//   BEFORE  what the pre-P2a note-refs reader listed for the note (frontmatter `sources:` as
//           added, body links as cited, each resolved against public.sources);
//   AFTER   the holder's references (provenance user, scope source, pinned at the source's
//           current revision, a quote and position from the opening of that revision);
// and a note whose BEFORE and AFTER lists differ is rolled back and reported - it FAILS the run.
// A note already migrated is skipped (the run is re-runnable). --dry-run checks every note and
// rolls every one back.
//
// Output: one JSON report on stdout - per note {path, migrated, skipped, before, after,
// references_created} or {path, refused, reason, detail} - and the totals. Exit 0 = every note
// migrated (or skipped) with equal lists; 1 = at least one note refused; 2 = could not run.
import { config } from "../config.ts";
import { pool } from "../db/pool.ts";
import { poolDb } from "./db.ts";
import { MigrationRefused, syncLegacyNote, type SyncReport } from "./repo/references.ts";

async function noteFiles(root: string, rel = "notes"): Promise<string[]> {
  const out: string[] = [];
  let entries: Deno.DirEntry[] = [];
  try {
    for await (const e of Deno.readDir(`${root}/${rel}`)) entries.push(e);
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory) out.push(...await noteFiles(root, child));
    else if (e.isFile && e.name.endsWith(".md")) out.push(child);
  }
  return out;
}

if (import.meta.main) {
  const dryRun = Deno.args.includes("--dry-run");
  const db = poolDb(pool);
  const notes: (SyncReport | { path: string; refused: true; reason: string; detail: unknown })[] = [];
  let refused = 0;
  try {
    for (const rel of await noteFiles(config.vault.gitDir)) {
      const content = await Deno.readTextFile(`${config.vault.gitDir}/${rel}`);
      try {
        notes.push(await syncLegacyNote(db, rel, content, { onlyIfUnmigrated: true, dryRun, by: "migration" }));
      } catch (e) {
        if (!(e instanceof MigrationRefused)) throw e;
        refused++;
        notes.push({ path: rel, refused: true, reason: e.message, detail: e.detail });
      }
    }
  } catch (e) {
    console.error(`[migrate-references] could not run: ${(e as Error).message}`);
    await pool.end().catch(() => {});
    Deno.exit(2);
  }
  const ok = notes.filter((n): n is SyncReport => !("refused" in n));
  const sum = (f: (n: SyncReport) => number) => ok.reduce((a, n) => a + f(n), 0);
  const totals = {
    notes: notes.length,
    migrated: ok.filter((n) => n.migrated).length,
    skipped: ok.filter((n) => n.skipped).length,
    refused,
    references_before: sum((n) => n.before?.total ?? 0),
    references_after: sum((n) => (n.migrated ? n.after.total : 0)),
    references_created: sum((n) => n.references_created),
    unresolved_citations: sum((n) => (n.migrated ? n.after.unresolved : 0)),
  };
  console.log(JSON.stringify({ dry_run: dryRun, vault: config.vault.gitDir, totals, notes }, null, 2));
  await pool.end().catch(() => {});
  Deno.exit(refused ? 1 : 0);
}
