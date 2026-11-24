// A fake of the workbench's documents back end for the Documents screen's tests (rwr-docs-list): the vitest suite
// (test/documents.test.tsx) and the e2e stub (e2e/docs.stub.mjs) both drive THIS one, so the two cannot drift.
// It copies the real routes' behaviour as the app sees it (OB1/docker/workbench/src/routes/documents.ts,
// routes/documents_lifecycle.ts, documents/repo.ts, documents/lifecycle.ts, documents/paths.ts):
//   - every document lives under documents/<owner key>/; trash and archive are its .trash / .archive sub-trees;
//   - another person's document answers EXACTLY like a missing one: 404 {"error":"no such document"};
//   - a move (archive, unarchive, trash, restore) keeps the document's history and sets its listing date to now;
//   - delete-forever and empty-trash need confirm: true (400 otherwise, nothing touched); empty-trash removes only
//     the caller's own trashed documents; each removal writes one trail line (path, kind, when - never text).
// rwr-doc-editor adds the writing surface's routes, copied from the same repo code:
//   - GET /documents/file answers { path, content, hash } with hash = the SHA-256 hex of the file (repo.ts sha256);
//   - PUT /documents/file?path=&commit=1 takes { content, if_match }: a stale if_match is 409
//     {"error":"conflict","current_hash":<hash>} and writes nothing (repo.ts saveDocument); a save answers
//     { path, hash, listing: { ok: true } }; commit=1 makes ONE commit and only when the file differs from the last
//     commit (vaultCommitPath: nothing to commit = no commit); the listing's title follows the file's (syncListing);
//   - GET /documents/history answers { path, commits: [{ hash, author, date, message }] } newest first, at most 30
//     (vaultFileHistory(rel, 30), content stripped);
//   - POST /documents/research answers 202 { job_id, refinery_id, kind }, 400 { error: "query is required" } for an
//     empty query, 404 for a document that is not the caller's (routes/documents.ts, refinery.queueResearch);
//   - GET /contract/references/<id> and /contract/chunks/<source>:<idx>/context answer the contract's shapes
//     (referenceById / sourceReference, chunkContext) for the planted references below.
// Opaque document ids (rwr-doc-opaque-urls): every document has an id (the listing row's, kept through a move); the
// listing and the state answer carry it, and GET /documents/resolve?id= answers the OWNER's document by it - another
// person's id, a deleted one and a made-up one are the same 404 (repo.ts documentById).
// The fake is not the server: the server's own isolation is tested by its lab (run-docs-lifecycle-tests.ps1).
import { createHash } from "node:crypto";

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
const sha256 = (t) => createHash("sha256").update(String(t), "utf8").digest("hex");
// the file as it lies in the vault: a planted document is its front matter (title as JSON) and its body
const fileText = (d) => d.raw ?? `---\ntitle: ${JSON.stringify(d.title)}\n---\n${d.body}`;
// the listing's title after a save: the front matter's, else the first heading, else the file name (grammar.ts titleOf)
const titleAfter = (content, path) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(content);
  let fm = "";
  if (m) { const t = /^title\s*:\s*(.*)$/m.exec(m[1]); if (t) { const v = t[1].trim(); try { fm = v.startsWith('"') ? JSON.parse(v) : v.replace(/^'|'$/g, ""); } catch { fm = v; } } }
  if (fm) return fm;
  const h = /^#\s+(.+)$/m.exec(content.slice(m ? m[0].length : 0));
  return h ? h[1].trim() : (path.split("/").pop() ?? path).replace(/\.md$/i, "");
};
const HISTORY_CAP = 30; // vaultFileHistory(rel, 30)
const commitsOf = (d, path, who) => d.history.map((message, i) => ({
  hash: createHash("sha1").update(`${path}:${i}:${message}`).digest("hex"), author: who.name,
  date: (d.hdates ?? [])[i] ?? d.updated, message,
})).reverse().slice(0, HISTORY_CAP);

// a stable uuid-shaped id from a text (the listing row's id: nothing of the path or the title is in it)
export const uid = (text) => {
  const h = createHash("sha256").update("opaque:" + text).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
let made = 0;

// Planted data: every title and text of alice's carries ALPHA, every one of bob's BRAVO, so a leak is a string match.
export function seed(now = Date.now()) {
  const iso = (ms) => new Date(now - ms).toISOString();
  const doc = (owner, path, title, body, msAgo, links = []) => [path, { id: uid(path), owner, title, body, updated: iso(msAgo), links, history: ["created " + path] }];
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
    research: [],
    refs: new Map(REFS.map(([k, v]) => [k, { ...v }])),
  };
}

// Planted references (shared knowledge in the real server: a reference record is read by its id). The source text
// carries the marker SRC-ALPHA.
export const REF_A = "a1000000-0000-4000-8000-0000000000a1";
export const REF_B = "a1000000-0000-4000-8000-0000000000b2";
export const SRC_A = "b1000000-0000-4000-8000-0000000000a1";
export const REF_C = "a1000000-0000-4000-8000-0000000000c3"; // a reference into a HELD source (title in held.title, source null)
export const SRC_C = "b1000000-0000-4000-8000-0000000000c3";
const REFS = [
  [REF_A, { source_id: SRC_A, title: "SRC-ALPHA Socket guide", pinned_revision: 2, current: 3, chunk_idx: 1, quote: "the LGA2066 socket takes a 165 W part",
    chunks: ["SRC-ALPHA intro chunk.", "Chunk two: the LGA2066 socket takes a 165 W part, per the vendor.", "SRC-ALPHA closing chunk."] }],
  [REF_C, { source_id: SRC_C, title: "SRC-ALPHA Held notes", pinned_revision: 1, current: 1, chunk_idx: 0, quote: "held words only the refinery has", held: true,
    chunks: ["Held chunk zero: held words only the refinery has."] }],
  [REF_B, { source_id: "b1000000-0000-4000-8000-0000000000b2", title: "SRC-ALPHA Whole source", pinned_revision: 1, current: 1, chunk_idx: null, quote: "a whole-source pin", chunks: [] }],
];

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
    const at = new Date(clock()).toISOString();
    db.docs.set(to, { ...d, updated: at, history: [...d.history, `${what} ${from} -> ${to}`], hdates: [...(d.hdates ?? d.history.map(() => d.updated)), at] });
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
    if (!who) return p.startsWith("/workbench/documents") || p.startsWith("/workbench/contract/") ? { status: 401, body: { error: "sign in" } } : null;
    const q = (k) => u.searchParams.get(k) ?? "";
    if (p === "/workbench/contract/documents" && method === "GET") {
      const lim = Math.min(500, Number(q("limit") || 100));
      const rows = [...db.docs.entries()].filter(([, d]) => d.owner === who.sub)
        .sort((a, b) => b[1].updated.localeCompare(a[1].updated)).slice(0, lim)
        .map(([path, d]) => ({ id: d.id, title: d.title, path, updated: d.updated, outbound_links: d.links.map((l) => ({ ...l, pin: null, reference_id: null })) }));
      return { status: 200, body: { documents: rows } };
    }
    const rm = /^\/workbench\/contract\/references\/([^/]+)$/.exec(p);
    if (rm && method === "GET") {
      const id = decodeURIComponent(rm[1]);
      const ref = db.refs.get(id);
      if (!ref) return { status: 404, body: { error: "no reference record, source, held source or tombstone with this id" } };
      return { status: 200, body: {
        id, kind: "reference", requested_version: ref.pinned_revision, tombstone: null, held: null,
        record: { id, source_id: ref.source_id, scope: ref.chunk_idx === null ? "source" : "passage", pinned_revision: ref.pinned_revision,
          chunk_idx: ref.chunk_idx, state: "active", selectors: { quote: { exact: ref.quote } }, created_by: "lab", created_at: "2026-01-01T00:00:00.000Z" },
        ...(ref.held ? {
          // referenceById, the held branch: source is null, the title and excerpt are in held; state "held", lifecycle "held"
          state: "held", lifecycle: "held", version: ref.current, state_detail: { refinery_id: "r-1", scope: "refinery only until folded" }, source: null,
          held: { refinery_id: "r-1", title: ref.title, url: null, excerpt: ref.quote, user_source_status: "ready" },
        } : {
        state: ref.current > ref.pinned_revision ? "updated" : "active", lifecycle: "active", version: ref.current, state_detail: {},
        source: { title: ref.title, url: null, content_type: "text/plain", domain: null, family: "general", excerpt: ref.quote, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" },
        }),
      } };
    }
    const cm = /^\/workbench\/contract\/chunks\/([0-9a-f-]{36}):(\d{1,6})\/context$/i.exec(decodeURIComponent(p)); // the server's router decodes a path parameter
    if (cm && method === "GET") {
      const ref = [...db.refs.values()].find((x) => x.source_id === cm[1]);
      const idx = Number(cm[2]), win = Math.min(10, Number(q("window") || 1));
      if (!ref || !ref.chunks[idx]) return { status: 404, body: { error: "no such chunk" } };
      return { status: 200, body: {
        chunk_id: `${cm[1]}:${idx}`, source_id: cm[1], idx, window: win, state: "active", lifecycle: "active", state_detail: {},
        chunks: ref.chunks.map((content, i) => ({ idx: i, content })).filter((c) => Math.abs(c.idx - idx) <= win).map((c) => ({ ...c, is_target: c.idx === idx })),
      } };
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
      const at = new Date(clock()).toISOString();
      const d = { id: uid("made-" + (++made) + "-" + at), owner: who.sub, title, body: "", updated: at, links: [], history: ["created " + path], hdates: [at] };
      d.committed = fileText(d);
      db.docs.set(path, d);
      return { status: 201, body: { path, hash: sha256(fileText(d)), listing: { ok: true } } };
    }
    if (p === "/workbench/documents/resolve" && method === "GET") {
      const hit = [...db.docs.entries()].find(([, d]) => d.id === q("id") && d.owner === who.sub);
      if (!hit) return NO;
      const [path] = hit;
      return { status: 200, body: { id: hit[1].id, path, listed: true, trashed: isTrashed(path), archived: isArchived(path), carries_idea: false, refinery: null, tags: [] } };
    }
    if (p === "/workbench/documents/state" && method === "GET") {
      const path = rel(q("path"), who);
      // as repo.ts documentState: someone else's (or outside the caller's directory) is a 404; a path in the
      // caller's OWN directory that has no listing row (deleted forever, or never there) is 200 listed:false
      if (!mine(path, who)) {
        if (db.docs.has(path) || !path.startsWith(r + "/")) return NO;
        return { status: 200, body: { path, listed: false, trashed: isTrashed(path), archived: isArchived(path), carries_idea: false, refinery: null, tags: [] } };
      }
      return { status: 200, body: { id: db.docs.get(path).id, path, listed: true, trashed: isTrashed(path), archived: isArchived(path), carries_idea: false, refinery: null, tags: [] } };
    }
    if (p === "/workbench/documents/file" && method === "GET") {
      const path = rel(q("path"), who);
      const d = mine(path, who);
      if (!d) return NO;
      return { status: 200, body: { path, content: fileText(d), hash: sha256(fileText(d)) } };
    }
    if (p === "/workbench/documents/file" && method === "PUT") {
      const path = rel(q("path"), who);
      const d = mine(path, who);
      if (!d) return NO;
      const current = sha256(fileText(d));
      if (body.if_match != null && current !== body.if_match) return { status: 409, body: { error: "conflict", current_hash: current } };
      const content = String(body.content ?? "");
      const lastCommitted = d.committed ?? fileText(d);
      d.raw = content;
      d.title = titleAfter(content, path);
      d.updated = new Date(clock()).toISOString();
      if (q("commit") === "1" && lastCommitted !== content) {
        d.committed = content;
        d.hdates = [...(d.hdates ?? d.history.map(() => d.updated)), d.updated];
        d.history.push(`documents: edit ${path}`);
      }
      return { status: 200, body: { path, hash: sha256(content), listing: { ok: true } } };
    }
    if (p === "/workbench/documents/history" && method === "GET") {
      const path = rel(q("path"), who);
      const d = mine(path, who);
      return d ? { status: 200, body: { path, commits: commitsOf(d, path, who) } } : NO;
    }
    if (p === "/workbench/documents/trail" && method === "GET") {
      return { status: 200, body: { lines: db.trail.filter((t) => t.owner === who.sub).map(({ owner: _o, ...t }) => t) } };
    }
    if (method !== "POST") return { status: 404, body: { error: "not found" } };
    if (p === "/workbench/documents/research") {
      if (!String(body.query ?? "").trim()) return { status: 400, body: { error: "query is required" } };
      if (!mine(rel(body.path, who), who)) return NO;
      const kind = body.kind === "gap" ? "gap" : "research";
      const job = { job_id: `j-${db.research.length + 1}`, owner: who.sub, path: rel(body.path, who), query: String(body.query), kind };
      db.research.push(job);
      return { status: 202, body: { job_id: job.job_id, refinery_id: null, kind } };
    }
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
