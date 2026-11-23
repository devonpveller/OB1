// deno test -A src/documents/lifecycle_test.ts - the document lifecycle's last steps
// (rwr-docs-lifecycle-api) over a REAL temporary git vault and an in-memory database stand-in: unarchive,
// delete forever (owner / other user / admin / not in the trash), empty trash (own only), the nightly
// 30-day removal with the clock injected, the trail (one line per removal, no body text), and (round 2) the
// races: parallel deletes of one document, empty trash against a restore, a failing removal.
// The HTTP side (confirm field, routes, two sessions, the owner scope) is lifecycle_integration_test.ts.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const vault = await Deno.makeTempDir({ prefix: "lifecycle-vault-" });
const prevGitDir = Deno.env.get("WIKI_GIT_DIR"); // restored at the end: the variable is the process's, not this file's
Deno.env.set("WIKI_GIT_DIR", vault);
const sh = async (env: Record<string, string>, ...a: string[]) => {
  const r = await new Deno.Command("git", { args: ["-C", vault, ...a], env, stdout: "piped", stderr: "piped" }).output();
  if (!r.success) throw new Error(new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout);
};
await sh({}, "init", "-q");
await sh({}, "config", "user.email", "t@lab.local");
await sh({}, "config", "user.name", "lab");

const docs = await import("./repo.ts");
const life = await import("./lifecycle.ts");
const trail = await import("./trail.ts");
type Identity = import("../middleware/identity.ts").Identity;
type DocErr = InstanceType<typeof docs.DocError>;

// ── an in-memory stand-in for the tables the code touches ────────────────────────────────
interface L { id: string; path: string; title: string; updated_at: Date; owner_sub: string }
const listings = new Map<string, L>();
const trailRows: Record<string, unknown>[] = [];
const auditRows: Record<string, unknown>[] = [];
let trailSeq = 0;
let failTrailInsert = false;
const db: import("../contracts/db.ts").Db = {
  query: (sql: string, a: unknown[] = []) => {
    if (/^\s*SELECT .*FROM public\.user_document_listings WHERE path = \$1/s.test(sql)) {
      const l = listings.get(a[0] as string);
      return Promise.resolve(l ? [{ ...l, refinery_id: null }] : []) as never;
    }
    if (/SELECT sub FROM public\.workspace_users/.test(sql)) return Promise.resolve([{ sub: "alice" }, { sub: "bob" }]) as never;
    if (/UPDATE public\.user_document_listings SET path = \$2/.test(sql)) {
      const l = listings.get(a[0] as string);
      if (l) {
        listings.delete(l.path);
        listings.set(a[1] as string, { ...l, path: a[1] as string, updated_at: new Date() });
      }
      return Promise.resolve([]) as never;
    }
    if (/DELETE FROM public\.user_document_listings WHERE path = \$1/.test(sql)) {
      listings.delete(a[0] as string);
      return Promise.resolve([]) as never;
    }
    if (/INSERT INTO public\.user_document_trail/.test(sql)) {
      if (failTrailInsert) return Promise.reject(new Error("trail table is down")) as never;
      const id = String(++trailSeq);
      const [owner_sub, actor_sub, kind, document_id, path, trashed_at] = a as [string, string, string, string | null, string, Date | null];
      trailRows.push({ id, owner_sub, actor_sub, kind, document_id, path, trashed_at });
      return Promise.resolve([{ id }]) as never;
    }
    if (/INSERT INTO public\.admin_audit/.test(sql)) {
      const [actor_sub, subject_sub, action, reason, method, route] = a as string[];
      auditRows.push({ actor_sub, subject_sub, action, reason, method, route, filesThen: [...trailRows].length });
      return Promise.resolve([]) as never;
    }
    if (/FROM public\.user_document_trail WHERE owner_sub = \$1 ORDER/.test(sql)) {
      return Promise.resolve(trailRows.filter((r) => r.owner_sub === a[0]).reverse()) as never;
    }
    if (/count\(\*\)/.test(sql)) return Promise.resolve([{ n: String(trailRows.filter((r) => r.owner_sub === a[0]).length) }]) as never;
    return Promise.resolve([]) as never;
  },
  tx: (fn) => fn(db),
};
const deps = { db, reg: {} as never };

// the directory key of a subject is the subject itself when it is a safe name (identity.ts ownerKey)
const id = (sub: string, over: Partial<Identity> = {}): Identity => ({
  sub, actor: sub, name: sub, key: sub, kind: "user", admin: false, impersonating: null, ...over,
});
const A = id("alice");
const B = id("bob");
const ADMIN = id("root", { admin: true });
const DAY = 86_400_000;

let n = 0;
// a document committed in the vault and listed for its owner; `where` = "" (live), ".trash" or ".archive";
// `when` dates the commit (author AND committer) and the listing row - the moment it went there
async function plant(
  who: Identity, where: "" | ".trash" | ".archive", body: string, title = `T${++n}`,
  o: { when?: Date; listed?: boolean; listedOwner?: string; authorWhen?: Date; listWhen?: Date } = {},
) {
  const dir = where ? `documents/${who.key}/${where}/notes` : `documents/${who.key}/notes`;
  const rel = `${dir}/${title.toLowerCase()}.md`;
  await Deno.mkdir(`${vault}/${dir}`, { recursive: true });
  await Deno.writeTextFile(`${vault}/${rel}`, `# ${title}\n\n${body}\n`);
  await sh({}, "add", "--", rel);
  const when = o.when ?? new Date();
  await sh({ GIT_COMMITTER_DATE: when.toISOString(), GIT_AUTHOR_DATE: (o.authorWhen ?? when).toISOString() }, "commit", "-q", "-m", `plant ${rel}`);
  if (o.listed !== false) {
    listings.set(rel, { id: crypto.randomUUID(), path: rel, title, updated_at: o.listWhen ?? when, owner_sub: o.listedOwner ?? who.sub });
  }
  return rel;
}
const exists = async (rel: string) => await Deno.stat(`${vault}/${rel}`).then(() => true, () => false);
const gitLog = (...a: string[]) => sh({}, ...a);

Deno.test("archive then unarchive: the document is back in its folder with its history and text", async () => {
  const rel = await plant(A, "", "UNARCHIVE-BODY-1");
  const archived = (await docs.archiveDocument(deps, rel, A)).archived;
  assert(archived.includes("/.archive/") && !(await exists(rel)));
  const back = (await life.unarchiveDocument(deps, archived, A)).unarchived;
  assertEquals(back, rel);
  assertEquals(await Deno.readTextFile(`${vault}/${rel}`), `# ${listings.get(rel)!.title}\n\nUNARCHIVE-BODY-1\n`);
  const h = await docs.history(deps, rel, A);
  const msgs = h.commits.map((c) => c.message).join("\n");
  assert(msgs.includes("plant") && msgs.includes("archive") && msgs.includes("unarchive"), msgs);
  assert(listings.has(rel) && !listings.has(archived), "the listing row followed the document");
  await assertRejects(() => life.unarchiveDocument(deps, rel, A), docs.DocError, "not in the archive");
  const other = await docs.archiveDocument(deps, await plant(B, "", "x"), B);
  const e = await assertRejects(() => life.unarchiveDocument(deps, other.archived, A), docs.DocError);
  assertEquals((e as DocErr).status, 404);
});

Deno.test("delete forever on an active document is refused and nothing is removed", async () => {
  const rel = await plant(A, "", "ACTIVE-BODY");
  const before = trailRows.length;
  const e = await assertRejects(() => life.deleteForever(deps, rel, A), docs.DocError);
  assertEquals((e as DocErr).status, 400);
  assert(await exists(rel) && listings.has(rel));
  assertEquals(trailRows.length, before, "no trail line for a refusal");
  const arch = (await docs.archiveDocument(deps, rel, A)).archived;
  await assertRejects(() => life.deleteForever(deps, arch, A), docs.DocError, "only a document in the trash");
  assert(await exists(arch));
});

Deno.test("delete forever: the owner may; another user gets the answer a missing document gets; an admin may (and is audited)", async () => {
  const rel = await plant(A, ".trash", "OWNER-BODY");
  const foreign = await assertRejects(() => life.deleteForever(deps, rel, B), docs.DocError);
  const missing = await assertRejects(() => life.deleteForever(deps, `documents/${B.key}/.trash/nope.md`, B), docs.DocError);
  assertEquals((foreign as Error).message, (missing as Error).message);
  assertEquals((foreign as DocErr).status, 404);
  assertEquals((missing as DocErr).status, 404);
  assert(await exists(rel), "refused: nothing removed");
  const imp = id("bob", { admin: true, impersonating: { reason: "r", since: "t" } });
  await assertRejects(() => life.deleteForever(deps, rel, imp), docs.DocError, "no such document");
  assert(await exists(rel));
  assertEquals(auditRows.length, 0, "a refusal is not an admin act");
  const out = await life.deleteForever(deps, rel, A);
  assertEquals(out.removed, true);
  assert(!(await exists(rel)) && !listings.has(rel));
  assertEquals(auditRows.length, 0, "an owner deleting their own is not an admin act");
  // an admin, another user's trashed document: audited BEFORE it runs
  const rel2 = await plant(B, ".trash", "ADMIN-BODY");
  const trailBefore = trailRows.length;
  assertEquals((await life.deleteForever(deps, rel2, ADMIN)).removed, true);
  assert(!(await exists(rel2)));
  assertEquals(auditRows.length, 1);
  assertEquals(
    [auditRows[0].actor_sub, auditRows[0].subject_sub, auditRows[0].action, auditRows[0].route],
    ["root", "bob", "request", "/workbench/documents/delete-forever"],
  );
  assertEquals(auditRows[0].filesThen, trailBefore, "the audit row was written before the removal's trail line");
  // ...but not another user's ACTIVE document
  const live = await plant(B, "", "LIVE-BODY");
  await assertRejects(() => life.deleteForever(deps, live, ADMIN), docs.DocError, "only a document in the trash");
  assert(await exists(live));
  const lines = trailRows.filter((r) => r.kind === "delete_forever");
  assertEquals(lines.map((l) => [l.owner_sub, l.actor_sub]), [["alice", "alice"], ["bob", "root"]]);
});

Deno.test("user A's empty trash removes only A's trashed documents and leaves B's untouched", async () => {
  const a1 = await plant(A, ".trash", "A1");
  const a2 = await plant(A, ".trash", "A2");
  const aLive = await plant(A, "", "A-LIVE");
  const b1 = await plant(B, ".trash", "B1");
  const b2 = await plant(B, ".trash", "B2");
  const out = await life.emptyOwnTrash(deps, A);
  assert(out.removed >= 2);
  assert(!(await exists(a1)) && !(await exists(a2)));
  assert(await exists(aLive), "A's live document stays");
  assert((await exists(b1)) && (await exists(b2)) && listings.has(b1) && listings.has(b2), "B's trash is untouched");
  assertEquals(trailRows.filter((r) => r.kind === "empty_trash" && r.owner_sub === "bob").length, 0);
  assertEquals((await life.emptyOwnTrash(deps, A)).removed, 0, "nothing left of A's");
  const outB = await life.emptyOwnTrash(deps, B);
  assert(outB.removed >= 2);
  assert(!(await exists(b1)));
});

Deno.test("F5: empty trash applies the same ownership test as delete forever - a file in A's directory that a listing row gives to B is not A's to remove", async () => {
  const odd = await plant(A, ".trash", "ODD", "OddOwner", { listedOwner: "bob" });
  const mine = await plant(A, ".trash", "MINE", "MineOwner");
  const before = trailRows.length;
  await assertRejects(() => life.deleteForever(deps, odd, A), docs.DocError, "no such document");
  const out = await life.emptyOwnTrash(deps, A);
  assertEquals(out.removed, 1);
  assert(await exists(odd) && listings.has(odd), "the oddly-owned file is left alone");
  assert(!(await exists(mine)));
  assertEquals(trailRows.length, before + 1);
  assertEquals(trailRows[trailRows.length - 1].owner_sub, "alice");
  await Deno.remove(`${vault}/${odd}`);
  listings.delete(odd);
});

Deno.test("nightly, clock injected: trashed 29 days ago survives, 31 days ago is removed", async () => {
  const now = new Date();
  const d29 = await plant(A, ".trash", "D29", "D29", { when: new Date(now.getTime() - 29 * DAY) });
  const d31 = await plant(A, ".trash", "D31", "D31", { when: new Date(now.getTime() - 31 * DAY) });
  const d30 = await plant(A, ".trash", "D30", "D30", { when: new Date(now.getTime() - 30 * DAY + 60_000) });
  const fresh = await plant(B, ".trash", "FRESH", "Fresh");
  const r = await docs.emptyTrash(deps, "nightly-cleanup", { now });
  assert(r.removed.includes(d31) && !(await exists(d31)), "31 days: removed");
  assert(!r.removed.includes(d29) && (await exists(d29)), "29 days: kept");
  assert(!r.removed.includes(d30) && (await exists(d30)), "just under 30 days: kept");
  assert(!r.removed.includes(fresh) && (await exists(fresh)), "just trashed: kept");
  // the clock two days later: the 29-day one is now 31 days old
  const later = await docs.emptyTrash(deps, "nightly-cleanup", { now: new Date(now.getTime() + 2 * DAY) });
  assert(later.removed.includes(d29) && later.removed.includes(d30) && !later.removed.includes(fresh));
  assert(!(await exists(d29)));
  const last = await docs.emptyTrash(deps, "nightly-cleanup", { now: new Date(now.getTime() + 31 * DAY) });
  assert(last.removed.includes(fresh));
});

Deno.test("F3: the trash date never makes a document older than it is - the LATER of the listing and the committer date; the author date is ignored", async () => {
  const now = new Date();
  const old = new Date(now.getTime() - 40 * DAY);
  // the listing says 40 days, the trash commit (committer) says now: kept
  const a = await plant(A, ".trash", "F3A", "F3a", { when: now, listWhen: old });
  // the listing says now, the commit's AUTHOR date says 40 days but the committer date is now: kept
  const b = await plant(A, ".trash", "F3B", "F3b", { when: now, authorWhen: old });
  // both genuinely old: removed
  const c = await plant(A, ".trash", "F3C", "F3c", { when: old });
  const r = await docs.emptyTrash(deps, "nightly-cleanup", { now });
  assert(!r.removed.includes(a) && (await exists(a)), "a skewed-behind listing cannot age a document");
  assert(!r.removed.includes(b) && (await exists(b)), "an author date cannot age a document");
  assert(r.removed.includes(c) && !(await exists(c)), "old by both clocks: removed");
  await Deno.remove(`${vault}/${a}`);
  await Deno.remove(`${vault}/${b}`);
  listings.delete(a);
  listings.delete(b);
});

Deno.test("the nightly run never removes a document with an unknowable trash date", async () => {
  const rel = `documents/${A.key}/.trash/undated.md`;
  await Deno.mkdir(`${vault}/documents/${A.key}/.trash`, { recursive: true });
  await Deno.writeTextFile(`${vault}/${rel}`, "# undated\n"); // untracked: no commit date, no listing row
  const r = await docs.emptyTrash(deps, "nightly-cleanup", { now: new Date(Date.now() + 365 * DAY) });
  assert(!r.removed.includes(rel) && (await exists(rel)));
  await Deno.remove(`${vault}/${rel}`); // not part of the later cases
});

Deno.test("F4: a nightly line for an unlisted document in a user's own directory is that user's, not nobody's", async () => {
  const before = trailRows.length;
  const rel = await plant(A, ".trash", "UNLISTED", "Unlisted", { when: new Date(Date.now() - 45 * DAY), listed: false });
  const r = await docs.emptyTrash(deps, "nightly-cleanup");
  assert(r.removed.includes(rel));
  assertEquals(trailRows.length, before + 1);
  assertEquals(trailRows[trailRows.length - 1].owner_sub, "alice");
  assertEquals(trailRows[trailRows.length - 1].actor_sub, "system:nightly");
  // a directory no known subject owns stays nobody's
  const stray = await plant(id("stranger"), ".trash", "STRAY", "Stray", { when: new Date(Date.now() - 45 * DAY), listed: false });
  await docs.emptyTrash(deps, "nightly-cleanup");
  assert(!(await exists(stray)));
  assertEquals(trailRows[trailRows.length - 1].owner_sub, "system:unowned");
});

Deno.test("R4: an unlisted trashed file is dated by its trash commit's COMMITTER date: an old author date with a recent committer date is kept", async () => {
  const now = new Date();
  // no listing row, so the commit date alone decides; the author date says 40 days, the committer date 1 day
  const rel = await plant(A, ".trash", "R4-BODY", "R4Unlisted", {
    when: new Date(now.getTime() - 1 * DAY), authorWhen: new Date(now.getTime() - 40 * DAY), listed: false,
  });
  assert(!listings.has(rel));
  const r = await docs.emptyTrash(deps, "nightly-cleanup", { now });
  assert(!r.removed.includes(rel) && (await exists(rel)), "an old author date cannot age an unlisted document");
  // and the committer date really is what counts: 31 days on from it, the same file goes
  const later = await docs.emptyTrash(deps, "nightly-cleanup", { now: new Date(now.getTime() + 31 * DAY) });
  assert(later.removed.includes(rel) && !(await exists(rel)));
});

Deno.test("R2: an admin delete forever of an unlisted trashed file in another user's folder names that user in the audit row and the trail line", async () => {
  const rel = await plant(B, ".trash", "R2-BODY", "R2Unlisted", { listed: false });
  assert(!listings.has(rel));
  const auditBefore = auditRows.length;
  const out = await life.deleteForever(deps, rel, ADMIN);
  assertEquals(out.removed, true);
  assert(!(await exists(rel)));
  assertEquals(auditRows.length, auditBefore + 1);
  assertEquals([auditRows[auditBefore].actor_sub, auditRows[auditBefore].subject_sub], ["root", "bob"], "the audit names whose data it was");
  const line = trailRows.find((r) => r.path === rel)!;
  assertEquals([line.owner_sub, line.actor_sub, line.kind], ["bob", "root", "delete_forever"]);
  assert(!trailRows.some((r) => r.owner_sub === "system:unowned" && r.path === rel));
  // the owner sees it in their own trail
  assert((await trail.readTrail(db, B)).lines.some((l) => l.path === rel), "B's GET /trail shows the admin's removal");
});

Deno.test("each hard removal writes exactly one trail line and the line holds no body text or title (any letter case)", async () => {
  trailRows.length = 0;
  const marker = "BODYMARK-" + crypto.randomUUID();
  const t1 = await plant(A, ".trash", marker, "TitleMark");
  const t2 = await plant(A, ".trash", marker);
  const t3 = await plant(A, ".trash", marker);
  await life.deleteForever(deps, t1, A);
  assertEquals(trailRows.length, 1);
  await life.emptyOwnTrash(deps, A);
  assertEquals(trailRows.length, 3, "one line per removed document, empty trash included");
  assertEquals(trailRows.map((r) => r.kind).sort(), ["delete_forever", "empty_trash", "empty_trash"]);
  assert(!(await exists(t2)) && !(await exists(t3)));
  const t4 = await plant(A, ".trash", marker, undefined, { when: new Date(Date.now() - 45 * DAY) });
  await docs.emptyTrash(deps, "nightly-cleanup");
  assertEquals(trailRows.length, 4);
  assertEquals(trailRows[3].kind, "nightly_expired");
  assertEquals(trailRows[3].actor_sub, "system:nightly");
  assert(!(await exists(t4)));
  // the marker is not in the row's other fields; the title slug IS the path by design (owner-only table), so the
  // title check looks at every field BUT the path, and at the whole line for the body marker
  const blob = (JSON.stringify(trailRows) + JSON.stringify(await trail.readTrail(db, A))).toLowerCase();
  assert(!blob.includes(marker.toLowerCase()), "no body text");
  const noPath = JSON.stringify(trailRows.map(({ path: _p, ...rest }) => rest)).toLowerCase();
  assert(!noPath.includes("titlemark"), "no title outside the path");
  assert((await gitLog("log", "--all", "-p")).includes(marker), "the vault commit keeps the text recoverable");
});

Deno.test("the trail is the caller's own: another user reads none of A's lines or count", async () => {
  const mine = await trail.readTrail(db, A);
  const theirs = await trail.readTrail(db, id("carol"));
  assert(mine.total > 0);
  assertEquals(theirs, { lines: [], total: 0 });
  assert(!JSON.stringify(await trail.readTrail(db, B)).includes("alice"));
});

// ── round 2: races and failures ─────────────────────────────────────────────────────────
Deno.test("F1: eight parallel delete-forevers of one document: exactly one removal, one trail line, the rest a 404", async () => {
  const rel = await plant(A, ".trash", "PARALLEL");
  const before = trailRows.length;
  const res = await Promise.allSettled(Array.from({ length: 8 }, () => life.deleteForever(deps, rel, A)));
  const ok = res.filter((r) => r.status === "fulfilled" && (r.value as { removed: boolean }).removed);
  const refused = res.filter((r) => r.status === "rejected" && ((r.reason as DocErr).status === 404));
  assertEquals(ok.length, 1, "exactly one caller removed it");
  assertEquals(refused.length, 7, "every other caller was told it is not there");
  assertEquals(trailRows.length - before, 1, "exactly one trail line");
  assert(!(await exists(rel)));
  // a second wave on the same path, as a retry would be: nothing
  await assertRejects(() => life.deleteForever(deps, rel, A), docs.DocError, "no such document");
  assertEquals(trailRows.length - before, 1);
});

Deno.test("F1: parallel empty-trash calls and delete-forever on the same documents write one line per document", async () => {
  const paths = [await plant(A, ".trash", "P1"), await plant(A, ".trash", "P2"), await plant(A, ".trash", "P3")]; // planted one by one: a plant is itself a git commit
  const before = trailRows.length;
  await Promise.all([
    life.emptyOwnTrash(deps, A), life.emptyOwnTrash(deps, A), life.deleteForever(deps, paths[0], A).catch(() => {}),
    docs.emptyTrash(deps, "nightly-cleanup", { now: new Date(Date.now() + 40 * DAY) }),
  ]);
  for (const p of paths) assert(!(await exists(p)));
  assertEquals(trailRows.length - before, 3, "three documents, three lines, however many callers raced");
  assertEquals(new Set(trailRows.slice(before).map((r) => r.path)).size, 3);
});

Deno.test("F2: empty trash racing a restore, eight rounds: a document is either alive with no line or removed with exactly one line, never both and never neither", async () => {
  for (let i = 0; i < 8; i++) {
    const trashedRel = await plant(A, ".trash", `RACE${i}`);
    const live = trashedRel.replace("/.trash/", "/");
    const before = trailRows.length;
    const res = await Promise.allSettled([life.emptyOwnTrash(deps, A), docs.restoreDocument(deps, trashedRel, A)]);
    const lines = trailRows.slice(before).filter((r) => r.path === trashedRel).length;
    const alive = await exists(live);
    const stillTrashed = await exists(trashedRel);
    assert(!stillTrashed, `round ${i}: not left in the trash`);
    assert(alive !== (lines === 1), `round ${i}: alive=${alive} lines=${lines} (restore ${res[1].status})`);
    assert(lines <= 1, `round ${i}: at most one line`);
    if (alive) assertEquals(lines, 0, `round ${i}: a living document has no removal line`);
    if (alive) await Deno.remove(`${vault}/${live}`);
  }
});

Deno.test("F2: the nightly racing a restore skips a document that is alive again", async () => {
  for (let i = 0; i < 4; i++) {
    const trashedRel = await plant(A, ".trash", `NIGHT${i}`, undefined, { when: new Date(Date.now() - 45 * DAY) });
    const live = trashedRel.replace("/.trash/", "/");
    const before = trailRows.length;
    await Promise.allSettled([docs.emptyTrash(deps, "nightly-cleanup"), docs.restoreDocument(deps, trashedRel, A)]);
    const lines = trailRows.slice(before).filter((r) => r.path === trashedRel).length;
    const alive = await exists(live);
    assert(alive !== (lines === 1), `round ${i}: alive=${alive} lines=${lines}`);
    if (alive) await Deno.remove(`${vault}/${live}`);
  }
});

Deno.test("F6: a removal that fails leaves no trail line and the document where it was", async () => {
  const rel = await plant(A, ".trash", "WONTGO");
  const before = trailRows.length;
  await Deno.writeTextFile(`${vault}/.git/index.lock`, ""); // git cannot take its lock: `git rm` fails
  try {
    await assertRejects(() => life.deleteForever(deps, rel, A));
    const e = await docs.emptyTrash(deps, "nightly-cleanup", { now: new Date(Date.now() + 90 * DAY) });
    assert(e.failed.includes(rel) && !e.removed.includes(rel));
  } finally {
    await Deno.remove(`${vault}/.git/index.lock`);
  }
  assert(await exists(rel) && listings.has(rel), "nothing removed");
  assertEquals(trailRows.length, before, "no trail line for a removal that did not happen");
  // and once git can work again the same document goes, with one line
  await life.deleteForever(deps, rel, A);
  assertEquals(trailRows.length, before + 1);
});

Deno.test("a trail line that cannot be written after the file is gone is reported, not undone", async () => {
  const rel = await plant(A, ".trash", "NOLINE");
  failTrailInsert = true;
  const before = trailRows.length;
  try {
    const out = await life.deleteForever(deps, rel, A);
    assertEquals(out.removed, true);
    assertEquals(out.trail, null);
  } finally {
    failTrailInsert = false;
  }
  assert(!(await exists(rel)));
  assertEquals(trailRows.length, before);
});

addEventListener("unload", () => {
  if (prevGitDir === undefined) Deno.env.delete("WIKI_GIT_DIR");
  else Deno.env.set("WIKI_GIT_DIR", prevGitDir);
  try {
    Deno.removeSync(vault, { recursive: true });
  } catch { /* best effort */ }
});

Deno.test("rwr-trail-grants-exact: restore and unarchive each write one line for the owner; a refused move and archive/trash write none", async () => {
  const rel = await plant(A, "", "BACK-BODY-1");
  const start = trailRows.length;
  const trashedTo = (await docs.trashDocument(deps, rel, A)).trashed;
  assertEquals(trailRows.length, start, "trash writes no line");
  // a refused restore (the name is taken) leaves no line and the file where it was
  await Deno.writeTextFile(`${vault}/${rel}`, "squatter");
  const e = await assertRejects(() => docs.restoreDocument(deps, trashedTo, A), docs.DocError);
  assertEquals((e as DocErr).status, 409);
  assertEquals(trailRows.length, start, "a refused move wrote no line");
  await Deno.remove(`${vault}/${rel}`);
  const back = (await docs.restoreDocument(deps, trashedTo, A)).restored;
  assertEquals(back, rel);
  assertEquals(trailRows.length, start + 1);
  const last = trailRows[trailRows.length - 1];
  assertEquals([last.kind, last.owner_sub, last.actor_sub, last.path, last.trashed_at], ["restored", "alice", "alice", rel, null]);
  const arch = (await docs.archiveDocument(deps, rel, A)).archived;
  assertEquals(trailRows.length, start + 1, "archive writes no line");
  await life.unarchiveDocument(deps, arch, A);
  assertEquals(trailRows.length, start + 2);
  assertEquals(trailRows[trailRows.length - 1].kind, "unarchived");
  assert(!JSON.stringify(trailRows.slice(start)).includes("BACK-BODY-1"), "no body in the lines");
  assert((await trail.readTrail(deps.db, A)).lines.some((l) => l.kind === "unarchived" && l.path === rel), "A reads it");
  assert(!(await trail.readTrail(deps.db, B)).lines.some((l) => l.path === rel), "B never does");
});
