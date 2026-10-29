// fixture-vault.ts - seeds the notes vault of a DISPOSABLE workbench container (rw-p0-contract,
// attempt 2, tester finding F7), so the eleven-router smoke's notes-list and notes-folders
// answer from a populated vault: a notebook with notes, a nested folder, an AI note, a README the
// listing filters out and an empty folder. run-contract-tests.ps1 copies this file into each
// :wt / pin-build container and runs it there, on that container's own /tmp vault:
//
//   deno run --allow-read --allow-write --allow-run /tmp/fixture-vault.ts /tmp/wiki
//
// Never point it at a live vault: it commits. Every path carries "rwp0-fixture" (the run's
// live-data guard requires it on every listed note) except the notebook slug, which is the
// fixture notebook's (fixtures.sql), and README.md, which the listing must drop.
export const MANIFEST: Record<string, string> = {
  "notes/notebooks/fixture-notebook/rwp0-fixture-note-1.md": "---\ntitle: Fixture note one\n---\n\nA note in the fixture notebook.\n",
  "notes/notebooks/fixture-notebook/rwp0-fixture-drafts/rwp0-fixture-note-2.md": "---\ntitle: Fixture note two\n---\n\nA nested note.\n",
  "notes/notebooks/fixture-notebook/README.md": "Dropped by the notes listing (README).\n",
  "notes/rwp0-fixture-ideas/rwp0-fixture-idea.md": "---\ntitle: Fixture idea note\n---\n\nTop-level folder note.\n",
  "notes/rwp0-fixture-empty/.gitkeep": "",
  "content/notebooks/fixture-notebook/rwp0-fixture-ai-note.md": "---\ntitle: Fixture AI note\n---\n\nAn AI note.\n",
  // the two user documents fixtures.sql lists (round 4: the listing is rebuildable from these files)
  "documents/fixture-refinery.md": "---\ntitle: Fixture refinery document\n---\n\nThe fixture refinery document.\n",
  "documents/links-suppressed.md": "---\ntitle: Document linking a suppressed source\n---\n\nThe fixture document that links a suppressed source.\n",
};

if (import.meta.main) {
  const dir = Deno.args[0];
  if (!dir || !dir.startsWith("/tmp/")) throw new Error("usage: fixture-vault.ts /tmp/<vault> (a disposable path only)");
  const git = async (...args: string[]) => {
    const r = await new Deno.Command("git", {
      args: ["-C", dir, "-c", "user.name=rwp0-fixture", "-c", "user.email=rwp0-fixture@example.invalid", ...args],
      env: { GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
      stdout: "piped", stderr: "piped",
    }).output();
    if (!r.success) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  };
  await Deno.mkdir(dir, { recursive: true });
  await git("init", "-q");
  for (const [rel, body] of Object.entries(MANIFEST)) {
    const abs = `${dir}/${rel}`;
    await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(abs, body);
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "rwp0 fixture vault");
  console.log(`seeded ${Object.keys(MANIFEST).length} files into ${dir}`);
}
