// A fake of the workbench's documents back end for the Documents screen's tests (rwr-docs-list): the vitest suite
// (test/documents.test.tsx) and the e2e stub (e2e/docs.stub.mjs) both drive THIS one, so the two cannot drift.
// It copies the real routes' behaviour as the app sees it (OB1/docker/workbench/src/routes/documents.ts,
// routes/documents_lifecycle.ts, documents/repo.ts, documents/lifecycle.ts, documents/paths.ts):
//   - every document lives under documents/<owner key>/; trash and archive are its .trash / .archive sub-trees;
//   - another person's document answers EXACTLY like a missing one: 404 {"error":"no such document"};
//   - a move (archive, unarchive, trash, restore) keeps the document's history and sets its listing date to now;
//   - delete-forever and empty-trash need confirm: true (400 otherwise, nothing touched); empty-trash removes only
//     the caller's own trashed documents; each removal writes one trail line (path, kind, when - never text).
// The fake is not the server: the server's own isolation is tested by its lab (run-docs-lifecycle-tests.ps1).

export const PEOPLE = {
  alice: { sub: "u-alice", key: "k-a", name: "Alice Lab" },
  bob: { sub: "u-bob", key: "k-b", name: "Bob Builder" },
};
const DAY = 86_400_000;
const SUBTREE = /^(documents\/(?:[^./][^/]*\/)?)\.(trash|archive)\//;
const isTrashed = (p) => SUBTREE.exec(p)?.[2] === "trash";
const isArchived = (p) => SUBTREE.exec(p)?.[2] === "archive";
const liveRel = (p) => p.replace(SUBTREE, "$1");
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
const NO = { status: 404, body: { error: "no such document" } };

// Planted data: every title and text of alice's carries ALPHA, every one of bob's BRAVO, so a leak is a string match.
export function seed(now = Date.now()) {
  const iso = (ms) => new Date(now - ms).toISOString();
  const doc = (owner, path, title, body, msAgo, links = []) => [path, { owner, title, body, updated: iso(msAgo), links, history: ["created " + path] }];
  return {
    docs: new Map([
      doc("u-alice", "documents/k-a/Hardware/cpu.md", "ALPHA Upgrading the CPU", "ALPHA body of the CPU plan.\nSecond line.", 2 * 3600e3,
        [{ kind: "source", id: "s1" }, { kind: "source", id: "s2" }, { kind: "idea", id: "i1" }]),
      doc("u-alice", "documents/k-a/Stack/gateway.md", "ALPHA One gateway", "ALPHA gateway notes.", DAY, [{ kind: "source", id: "s3" }]),
      doc("u-alice", "documents/k-a/draft.md", "ALPHA Untitled draft", "", 7 * DAY),
      doc("u-alice", "documents/k-a/.archive/Stack/old-wiki.md", "ALPHA Old wiki plan", "ALPHA archived text.", 40 * DAY, [{ kind: "claim", id: "c1" }]),
      doc("u-alice", "documents/k-a/.trash/Hardware/dup.md", "ALPHA CPU duplicate", "ALPHA trashed text.", 2 * DAY),
      doc("u-bob", "documents/k-b/bravo.md", "BRAVO plan", "BRAVO text.", 3600e3),
      doc("u-bob", "documents/k-b/.trash/bravo-old.md", "BRAVO old", "BRAVO trashed.", 5 * DAY),
    ]),
    folders: new Set(["documents/k-a/Hardware", "documents/k-a/Stack", "documents/k-a/Recipes"]),
    trail: [],
  };
}

export function createFake(opts = {}) {
  let clock = opts.now ?? (() => Date.now());
  let db = seed(clock());
  const reset = () => { db = seed(clock()); };
  const rootOf = (who) => `documents/${who.key}`;
  const rel = (path, who) => (String(path ?? "").startsWith("documents/") ? String(path) : `${rootOf(who)}/${path}`);
  const mine = (path, who) => { const d = db.docs.get(path); return d && d.owner === who.sub ? d : null; };
  const inSub = (p, sub, who) => { const live = liveRel(p); const r = rootOf(who); return `${r}/${sub}/${live.slice(r.length + 1)}`; };
  const move = (from, to, what) => {
    if (db.docs.has(to)) return { status: 409, body: { error: "a document with that name already exists there" } };
    const d = db.docs.get(from);
    db.docs.delete(from);
    db.docs.set(to, { ...d, updated: new Date(clock()).toISOString(), history: [...d.history, `${what} ${from} -> ${to}`] });
    return null;
  };
  const remove = (p, who, kind) => {
    db.docs.delete(p);
    db.trail.push({ owner: who.sub, kind, path: p, at: new Date(clock()).toISOString() });
  };

  // handle(person, method, url, body) -> { status, body } | null (null: not a documents route)
  function handle(person, method, url, body = {}) {
    const who = PEOPLE[person];
    const u = new URL(url, "http://x");
    const p = u.pathname;
    if (!who) return p.startsWith("/workbench/documents") || p === "/workbench/contract/documents" ? { status: 401, body: { error: "sign in" } } : null;
    const q = (k) => u.searchParams.get(k) ?? "";
    if (p === "/workbench/contract/documents" && method === "GET") {
      const lim = Math.min(500, Number(q("limit") || 100));
      const rows = [...db.docs.entries()].filter(([, d]) => d.owner === who.sub)
        .sort((a, b) => b[1].updated.localeCompare(a[1].updated)).slice(0, lim)
        .map(([path, d]) => ({ title: d.title, path, updated: d.updated, outbound_links: d.links.map((l) => ({ ...l, pin: null, reference_id: null })) }));
      return { status: 200, body: { documents: rows } };
    }
    if (!p.startsWith("/workbench/documents")) return null;
    const r = rootOf(who);
    if (p === "/workbench/documents/folders" && method === "GET") {
      const dirs = new Set([...db.folders].filter((f) => f.startsWith(r + "/")));
      for (const [path, d] of db.docs) if (d.owner === who.sub && !isTrashed(path) && !isArchived(path)) { const i = path.lastIndexOf("/"); if (path.slice(0, i) !== r) dirs.add(path.slice(0, i)); }
      return { status: 200, body: { root: r, folders: ["", ...[...dirs].map((x) => x.slice(r.length + 1))].sort() } };
    }
    if (p === "/workbench/documents/folders" && method === "POST") {
      const name = String(body.path ?? "").trim();
      if (!name || name.split("/").some((s) => s.startsWith(".") || s === "")) return { status: 400, body: { error: "invalid folder name" } };
      const dir = `${r}/${name}`;
      const created = !db.folders.has(dir);
      db.folders.add(dir);
      return { status: created ? 201 : 200, body: { path: dir, created } };
    }
    if (p === "/workbench/documents" && method === "POST") {
      const title = String(body.title ?? "").trim();
      if (!title) return { status: 400, body: { error: "title is required" } };
      const f = String(body.folder ?? "").trim();
      const path = `${f ? `${r}/${f}` : r}/${slug(title)}.md`;
      if (db.docs.has(path)) return { status: 409, body: { error: "a document with that name already exists there" } };
      db.docs.set(path, { owner: who.sub, title, body: "", updated: new Date(clock()).toISOString(), links: [], history: ["created " + path] });
      return { status: 201, body: { path, hash: "h", listing: { ok: true } } };
    }
    if (p === "/workbench/documents/state" && method === "GET") {
      const path = rel(q("path"), who);
      if (!mine(path, who)) return NO;
      return { status: 200, body: { path, listed: true, trashed: isTrashed(path), archived: isArchived(path), carries_idea: false, refinery: null, tags: [] } };
    }
    if (p === "/workbench/documents/file" && method === "GET") {
      const path = rel(q("path"), who);
      const d = mine(path, who);
      if (!d) return NO;
      return { status: 200, body: { path, content: `---\ntitle: ${JSON.stringify(d.title)}\n---\n${d.body}`, hash: "h" } };
    }
    if (p === "/workbench/documents/history" && method === "GET") {
      const path = rel(q("path"), who);
      const d = mine(path, who);
      return d ? { status: 200, body: { path, commits: d.history.map((m) => ({ message: m })) } } : NO;
    }
    if (p === "/workbench/documents/trail" && method === "GET") {
      return { status: 200, body: { lines: db.trail.filter((t) => t.owner === who.sub).map(({ owner: _o, ...t }) => t) } };
    }
    if (method !== "POST") return { status: 404, body: { error: "not found" } };
    const path = rel(body.path, who);
    const lifecycle = ["/workbench/documents/delete-forever", "/workbench/documents/empty-trash"];
    if (lifecycle.includes(p) && body.confirm !== true) {
      return { status: 400, body: { error: (p.endsWith("empty-trash") ? "empty trash" : "delete forever") + " cannot be undone: send confirm: true" } };
    }
    if (p === "/workbench/documents/empty-trash") {
      let removed = 0;
      for (const [k, d] of [...db.docs]) if (d.owner === who.sub && isTrashed(k)) { remove(k, who, "empty_trash"); removed++; }
      return { status: 200, body: { removed, failed: 0 } };
    }
    if (!mine(path, who)) return NO;
    if (p === "/workbench/documents/archive") {
      if (isArchived(path)) return { status: 400, body: { error: "already archived" } };
      const to = inSub(path, ".archive", who);
      return move(path, to, "archive") ?? { status: 200, body: { archived: to, refinery: { refinery_id: null, archived: false } } };
    }
    if (p === "/workbench/documents/unarchive") {
      if (!isArchived(path)) return { status: 400, body: { error: "not in the archive" } };
      const to = liveRel(path);
      return move(path, to, "unarchive") ?? { status: 200, body: { unarchived: to, refinery: { refinery_id: null, archived: false } } };
    }
    if (p === "/workbench/documents/trash") {
      if (isTrashed(path)) return { status: 400, body: { error: "already in the trash" } };
      const to = inSub(path, ".trash", who);
      return move(path, to, "trash") ?? { status: 200, body: { trashed: to } };
    }
    if (p === "/workbench/documents/restore") {
      if (!isTrashed(path) && !isArchived(path)) return { status: 400, body: { error: "not in the trash or the archive" } };
      const to = liveRel(path);
      return move(path, to, "restore") ?? { status: 200, body: { restored: to } };
    }
    if (p === "/workbench/documents/delete-forever") {
      if (!isTrashed(path)) return { status: 400, body: { error: "only a document in the trash can be deleted forever; trash it first" } };
      remove(path, who, "delete_forever");
      return { status: 200, body: { removed: true, trail: "t" } };
    }
    return { status: 404, body: { error: "not found" } };
  }
  return { handle, reset, db: () => db, setClock: (f) => { clock = f; } };
}
