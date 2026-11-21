// deno test -A src/documents/lifecycle_test.ts - the document lifecycle's last steps
// (rwr-docs-lifecycle-api) over a REAL temporary git vault and an in-memory database stand-in: unarchive,
// delete forever (owner / other user / admin / not in the trash), empty trash (own only), the nightly
// 30-day removal with the clock injected, and the trail (one line per removal, no body text).
// The HTTP side (confirm field, routes, two sessions, the owner scope) is lifecycle_integration_test.ts.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const vault = await Deno.makeTempDir({ prefix: "lifecycle-vault-" });
const prevGitDir = Deno.env.get("WIKI_GIT_DIR"); // restored at the end: the variable is the process's, not this file's
Deno.env.set("WIKI_GIT_DIR", vault);
const sh = async (...a: string[]) => {
  const r = await new Deno.Command("git", { args: ["-C", vault, ...a], stdout: "piped", stderr: "piped" }).output();
  if (!r.success) throw new Error(new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout);
};
await sh("init", "-q");
await sh("config", "user.email", "t@lab.local");
await sh("config", "user.name", "lab");

const docs = await import("./repo.ts");
const life = await import("./lifecycle.ts");
const trail = await import("./trail.ts");
type Identity = import("../middleware/identity.ts").Identity;
type DocErr = InstanceType<typeof docs.DocError>;

// ── an in-memory stand-in for the three tables the code touches ──────────────────────────
interface L { id: string; path: string; title: string; updated_at: Date; owner_sub: string }
const listings = new Map<string, L>();
const trailRows: Record<string, unknown>[] = [];
let trailSeq = 0;
const db: import("../contracts/db.ts").Db = {
  query: (sql: string, a: unknown[] = []) => {
    if (/^\s*SELECT .*FROM public\.user_document_listings WHERE path = \$1/s.test(sql)) {
      const l = listings.get(a[0] as string);
      return Promise.resolve(l ? [{ ...l, refinery_id: null }] : []) as never;
    }
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
      const id = String(++trailSeq);
      const [owner_sub, actor_sub, kind, document_id, path, trashed_at] = a as [string, string, string, string | null, string, Date | null];
      trailRows.push({ id, owner_sub, actor_sub, kind, document_id, path, trashed_at });
      return Promise.resolve([{ id }]) as never;
    }
    if (/DELETE FROM public\.user_document_trail WHERE id/.test(sql)) {
      const i = trailRows.findIndex((r) => r.id === a[0]);
      if (i >= 0) trailRows.splice(i, 1);
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

const id = (sub: string, over: Partial<Identity> = {}): Identity => ({
  sub, actor: sub, name: sub, key: `k-${sub}`, kind: "user", admin: false, impersonating: null, ...over,
});
const A = id("alice");
const B = id("bob");
const ADMIN = id("root", { admin: true });

let n = 0;
// a document committed in the vault and listed for its owner; `where` = "" (live), ".trash" or ".archive"
async function plant(who: Identity, where: "" | ".trash" | ".archive", body: string, title = `T${++n}`) {
  const dir = where ? `documents/${who.key}/${where}/notes` : `documents/${who.key}/notes`;
  const rel = `${dir}/${title.toLowerCase()}.md`;
  await Deno.mkdir(`${vault}/${dir}`, { recursive: true });
  await Deno.writeTextFile(`${vault}/${rel}`, `# ${title}\n\n${body}\n`);
  await sh("add", "--", rel);
  await sh("commit", "-q", "-m", `plant ${rel}`);
  listings.set(rel, { id: crypto.randomUUID(), path: rel, title, updated_at: new Date(), owner_sub: who.sub });
  return rel;
}
const exists = async (rel: string) => await Deno.stat(`${vault}/${rel}`).then(() => true, () => false);
const DAY = 86_400_000;

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
  // a live document, or someone else's, cannot be unarchived
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
  // an archived one is not in the trash either
  const arch = (await docs.archiveDocument(deps, rel, A)).archived;
  await assertRejects(() => life.deleteForever(deps, arch, A), docs.DocError, "only a document in the trash");
  assert(await exists(arch));
});

Deno.test("delete forever: the owner may; another user gets the answer a missing document gets; an admin may", async () => {
  const rel = await plant(A, ".trash", "OWNER-BODY");
  // B names A's trashed document: the same 404 text as a path that does not exist
  const foreign = await assertRejects(() => life.deleteForever(deps, rel, B), docs.DocError);
  const missing = await assertRejects(() => life.deleteForever(deps, `documents/${B.key}/.trash/nope.md`, B), docs.DocError);
  assertEquals((foreign as Error).message, (missing as Error).message);
  assertEquals((foreign as DocErr).status, 404);
  assertEquals((missing as DocErr).status, 404);
  assert(await exists(rel), "refused: nothing removed");
  // an admin who is impersonating acts AS the user and gets no extra reach
  const imp = id("bob", { admin: true, impersonating: { reason: "r", since: "t" } });
  await assertRejects(() => life.deleteForever(deps, rel, imp), docs.DocError, "no such document");
  assert(await exists(rel));
  // the owner
  const out = await life.deleteForever(deps, rel, A);
  assertEquals(out.removed, true);
  assert(!(await exists(rel)) && !listings.has(rel));
  // an admin, another user's trashed document
  const rel2 = await plant(B, ".trash", "ADMIN-BODY");
  assertEquals((await life.deleteForever(deps, rel2, ADMIN)).removed, true);
  assert(!(await exists(rel2)));
  // ...but not another user's ACTIVE document
  const live = await plant(B, "", "LIVE-BODY");
  await assertRejects(() => life.deleteForever(deps, live, ADMIN), docs.DocError, "only a document in the trash");
  assert(await exists(live));
  // the trail names the owner of each, the actor who removed it
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
  // B's own empty works and counts only B's
  const outB = await life.emptyOwnTrash(deps, B);
  assert(outB.removed >= 2);
  assert(!(await exists(b1)));
});

Deno.test("nightly, clock injected: trashed 29 days ago survives, 31 days ago is removed", async () => {
  const young = await plant(A, ".trash", "YOUNG");
  const old = await plant(A, ".trash", "OLD");
  const real = new Date();
  // 29 days after both went in: both stay
  const r29 = await docs.emptyTrash(deps, "nightly-cleanup", { now: new Date(real.getTime() + 29 * DAY) });
  assert(!r29.removed.includes(young) && !r29.removed.includes(old), "29 days: neither is removed");
  assert((await exists(young)) && (await exists(old)));
  // OLD is recorded as trashed 40 days ago, YOUNG just now: at the real clock only OLD goes
  listings.get(old)!.updated_at = new Date(real.getTime() - 40 * DAY);
  const r = await docs.emptyTrash(deps, "nightly-cleanup", { now: new Date() });
  assert(r.removed.includes(old) && !(await exists(old)), "OLD (trashed 40 days ago) is removed");
  assert(!r.removed.includes(young) && (await exists(young)), "YOUNG stays");
  // 31 days after YOUNG went in: removed
  const r31 = await docs.emptyTrash(deps, "nightly-cleanup", { now: new Date(real.getTime() + 31 * DAY) });
  assert(r31.removed.includes(young) && !(await exists(young)), "31 days: removed");
});

Deno.test("the nightly run never removes a document with an unknowable trash date", async () => {
  const rel = `documents/${A.key}/.trash/undated.md`;
  await Deno.mkdir(`${vault}/documents/${A.key}/.trash`, { recursive: true });
  await Deno.writeTextFile(`${vault}/${rel}`, "# undated\n"); // untracked: no commit date, no listing row
  const r = await docs.emptyTrash(deps, "nightly-cleanup", { now: new Date(Date.now() + 365 * DAY) });
  assert(!r.removed.includes(rel) && (await exists(rel)));
  await Deno.remove(`${vault}/${rel}`); // not part of the later cases
});

Deno.test("each hard removal writes exactly one trail line and the line holds no body text or title", async () => {
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
  const t4 = await plant(A, ".trash", marker);
  listings.get(t4)!.updated_at = new Date(Date.now() - 45 * DAY);
  await docs.emptyTrash(deps, "nightly-cleanup");
  assertEquals(trailRows.length, 4);
  assertEquals(trailRows[3].kind, "nightly_expired");
  assertEquals(trailRows[3].actor_sub, "system:nightly");
  const blob = JSON.stringify(trailRows) + JSON.stringify(await trail.readTrail(db, A));
  assert(!blob.includes(marker) && !blob.includes("TitleMark"), "no body text, no title");
  // the vault commit of the removal is the recoverable record: the text is still in git history
  assert((await sh("log", "--all", "-p")).includes(marker));
});

Deno.test("the trail is the caller's own: another user reads none of A's lines or count", async () => {
  const mine = await trail.readTrail(db, A);
  const theirs = await trail.readTrail(db, id("carol"));
  assert(mine.total > 0);
  assertEquals(theirs, { lines: [], total: 0 });
  assert(!JSON.stringify(await trail.readTrail(db, B)).includes("alice"));
});

addEventListener("unload", () => {
  if (prevGitDir === undefined) Deno.env.delete("WIKI_GIT_DIR");
  else Deno.env.set("WIKI_GIT_DIR", prevGitDir);
  try {
    Deno.removeSync(vault, { recursive: true });
  } catch { /* best effort */ }
});
