// Stub workbench for the Removals e2e lab (rwr-removals): answers the reads and actions the Removals and trail
// screen makes, per "mode" (the person the stub pretends the request belongs to), with a world that CHANGES when an
// action is taken (an action leaves its line in the trail, as the real routes do). ALPHA rows are alice's, BRAVO bob's;
// the library's sources and trail are shared and carry no marker.
//   POST /__mode/<alice|bob>   switch who the next requests belong to
//   POST /__reset              rebuild the world
//   GET  /__log                every request seen (method, url, mode, whether the door key was present)
import http from "node:http";

const KEY = process.env.LAB_KEY || "";
const H = 3600 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const AID = (n) => `a1000000-0000-4000-8000-00000000000${n}`;
const BID = (n) => `b2000000-0000-4000-8000-00000000000${n}`;
const ev = (kind, source_id, o = {}) => ({ kind, source_id, tombstone_id: null, state: "current", reason: null, context: {}, at: ago(H), lifecycle: "suppressed", counts_as_evidence: false, ...o });

let W, mode = "alice", seq = 0;
const log = [];
function reset() {
  seq = 0;
  W = {
    src: [
      { id: "s1", title: "Hidden source one", url: "https://example.org/one", lifecycle: "suppressed", reason: "misattributed quote", suppressed_at: ago(5 * H), counts: { claim_edge: 2, chunk: 3, document_link: 1 }, blocking: 3, erase_allowed: false },
      { id: "s2", title: "Cut loose source two", url: "https://example.org/two", lifecycle: "unlinked", reason: "duplicate of another", suppressed_at: ago(4 * H), counts: {}, blocking: 0, erase_allowed: true },
      { id: "s3", title: "Held by private work", url: null, lifecycle: "suppressed", reason: "old", suppressed_at: ago(3 * H), counts: { reference_record: 4 }, blocking: 4, erase_allowed: false },
    ],
    trail: [
      ev("suppressed", "s1", { reason: "misattributed quote", context: { title: "Hidden source one", suppressed_by: "cleanup-action:" + AID(1) }, at: ago(5 * H) }),
      ev("suppressed", "s2", { reason: "duplicate of another", context: { title: "Cut loose source two", suppressed_by: "cleanup-action:" + BID(1) }, at: ago(4 * H) }),
      ev("suppressed", "s3", { reason: "old", context: { title: "Held by private work", suppressed_by: "cleanup-action:" + BID(2) }, at: ago(3 * H) }),
      ev("severed", "s2", { context: { kind: "chunk", ref: "0" }, at: ago(3.5 * H) }),
      ev("erased", "gone1", { tombstone_id: "t1", state: "erased", reason: "debunked", context: { title: "Erased shared source", url: "https://example.org/gone", eraser_kind: "user" }, lifecycle: "erased", at: ago(24 * H) }),
    ],
    tomb: { t1: { by: "alice", lifted: false } },
    acts: {
      alice: [{ id: AID(1), kind: "suppress", source_id: "s1", tombstone_id: null, created_at: ago(5 * H) }, { id: AID(2), kind: "erase", source_id: "gone1", tombstone_id: "t1", created_at: ago(24 * H) }],
      bob: [{ id: BID(1), kind: "suppress", source_id: "s2", tombstone_id: null, created_at: ago(4 * H) }],
    },
    docs: {
      alice: [
        { title: "ALPHA live plan", path: "documents/k-a/plan.md", updated: ago(H), outbound_links: [] },
        { title: "ALPHA trashed memo", path: "documents/k-a/.trash/memo.md", updated: ago(2 * H), outbound_links: [] },
        { title: "ALPHA archived notes", path: "documents/k-a/.archive/notes.md", updated: ago(3 * H), outbound_links: [] },
      ],
      bob: [{ title: "BRAVO trashed draft", path: "documents/k-b/.trash/draft.md", updated: ago(H), outbound_links: [] }],
    },
    ideas: {
      alice: [{ id: "i1", title: "ALPHA parked idea", status: "archived", updated_at: ago(6 * H), document_path: "documents/k-a/idea.md" }],
      bob: [{ id: "i9", title: "BRAVO archived idea", status: "archived", updated_at: ago(H), document_path: null }],
    },
    dtrail: {
      alice: [{ id: "l1", kind: "nightly_expired", path: "documents/k-a/.trash/ALPHA-expired.md", actor_sub: "system:nightly", trashed_at: ago(900 * H), created_at: ago(20 * H) }],
      bob: [{ id: "l9", kind: "delete_forever", path: "documents/k-b/.trash/BRAVO-gone.md", actor_sub: "u-bob", trashed_at: ago(H), created_at: ago(H) }],
    },
  };
}
reset();
const SUB = { alice: "u-alice", bob: "u-bob" };
const NAME = { alice: "Alice Lab", bob: "Bob Builder" };
const record = (kind, source_id, tombstone_id) => {
  const id = (mode === "alice" ? AID : BID)(5 + ++seq);
  W.acts[mode].push({ id, kind, source_id, tombstone_id, created_at: new Date().toISOString() });
};

http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/__log") return json(log);
  if (req.url === "/__reset" && req.method === "POST") { reset(); mode = "alice"; return json({ ok: true }); }
  if (req.url === "/__drop-docs" && req.method === "POST") { W.docs[mode] = []; return json({ ok: true }); }
  const m0 = req.url.match(/^\/__mode\/(\w+)$/);
  if (m0 && SUB[m0[1]]) { mode = m0[1]; return json({ mode }); }
  log.push({ method: req.method, url: req.url, mode, keyOk: req.headers["x-brain-key"] === KEY });
  const p = req.url.split("?")[0];
  const readBody = () => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b ? JSON.parse(b) : {})); });
  if (p === "/workbench/workspace/whoami") return json({ subject_sub: SUB[mode], actor_sub: SUB[mode], name: NAME[mode] });
  if (p === "/workbench/auth/me") return json({ mode: "forward-auth", signed_in: true, kind: "user", subject_sub: SUB[mode], name: NAME[mode] });
  if (p === "/workbench/settings") return json({ admin: false, settings: [] });
  if (p === "/workbench/contract/sessions") return json({ sessions: [] });
  if (p === "/workbench/intake/jobs") return json({ jobs: [] });
  if (p === "/workbench/contract/cleanup/reopen-candidates") return json({ candidates: [] });
  if (p === "/workbench/contract/cleanup/sources" && req.method === "GET") return json({ sources: W.src, total: W.src.length });
  if (p === "/workbench/contract/trail") return json({ entries: [...W.trail].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)), leads: [] });
  if (p === "/workbench/contract/cleanup/actions") return json({ actions: [...W.acts[mode]].reverse() });
  if (p === "/workbench/contract/documents") return json({ documents: W.docs[mode] });
  if (p === "/workbench/contract/ideas") return json({ ideas: W.ideas[mode] });
  if (p === "/workbench/documents/trail") return json({ lines: W.dtrail[mode], total: W.dtrail[mode].length });
  let m = p.match(/^\/workbench\/contract\/tombstones\/([^/]+)$/);
  if (m && req.method === "GET") { const t = W.tomb[m[1]]; return t ? json({ id: m[1], lifted_at: t.lifted ? ago(0) : null, may_lift: t.by === mode, erased_by_you: t.by === mode }) : json({ error: "no" }, 404); }
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  return readBody().then((b) => {
    m = p.match(/^\/workbench\/sources\/([^/]+)\/restore$/);
    if (m) {
      const s = W.src.find((x) => x.id === m[1]); if (!s) return json({ error: "not found" }, 404);
      W.src = W.src.filter((x) => x !== s); record("restore", s.id, null);
      // As the real routes: restore clears retraction_committed_at / unlinked_at (repositories/sources.ts:330-333), so the derived
      // 'suppressed' line (contracts/repo/knowledge.ts:468-473) is gone; the 'restored' line's detail is { from, to, reason, door }
      // with NO title (sources.ts:340-342).
      W.trail = W.trail.filter((e) => !(e.kind === "suppressed" && e.source_id === s.id));
      W.trail.push(ev("restored", s.id, { context: { from: s.lifecycle, to: "active", reason: s.reason, door: "POST /workbench/sources/:id/restore" }, lifecycle: "active", at: new Date().toISOString() }));
      return json({ source: { id: s.id }, transition: { from: s.lifecycle, to: "active" } });
    }
    m = p.match(/^\/workbench\/contract\/cleanup\/sources\/([^/]+)\/erase$/);
    if (m) {
      const s = W.src.find((x) => x.id === m[1]); if (!s) return json({ error: "no" }, 404);
      if (!s.erase_allowed) return json({ error: "erase refused" }, 409);
      W.src = W.src.filter((x) => x !== s);
      const tid = "t" + (10 + ++seq); W.tomb[tid] = { by: mode, lifted: false }; record("erase", s.id, tid);
      W.trail.push(ev("erased", s.id, { tombstone_id: tid, state: "erased", reason: b.reason_type, context: { title: s.title, url: s.url, eraser_kind: "user" }, lifecycle: "erased", at: new Date().toISOString() }));
      return json({ tombstone_id: tid, reason_type: b.reason_type });
    }
    m = p.match(/^\/workbench\/contract\/cleanup\/tombstones\/([^/]+)\/lift$/);
    if (m) {
      const t = W.tomb[m[1]]; if (!t) return json({ error: "no" }, 404);
      if (t.by !== mode) return json({ error: "only the eraser" }, 403);
      t.lifted = true; record("lift", null, m[1]);
      // As the real route: the trail() insert writes no tombstone_id column (contracts/repo/lifecycle.ts:36-41); the id is only in
      // detail (:343), which the trail read returns as context (contracts/repo/knowledge.ts:484).
      W.trail.push(ev("lifted", "gone1", { tombstone_id: null, context: { tombstone_id: m[1], note: null }, lifecycle: "erased", at: new Date().toISOString() }));
      return json({ tombstone_id: m[1] });
    }
    const d = () => W.docs[mode].find((x) => x.path === b.path);
    // As the real doors: documents/repo.ts:241-245 (restoreDocument, { trail: "restored" }) and the unarchive door write a put-back
    // line to documents/trail (documents/trail.ts:8 TrailKind).
    const putBack = (kind, path) => W.dtrail[mode].unshift({ id: "lp" + ++seq, kind, path, actor_sub: SUB[mode], trashed_at: null, created_at: new Date().toISOString() });
    if (p === "/workbench/documents/restore") { const x = d(); if (!x) return json({ error: "no such document" }, 404); x.path = x.path.replace("/.trash/", "/").replace("/.archive/", "/"); putBack("restored", x.path); return json({ restored: x.path }); }
    if (p === "/workbench/documents/unarchive") { const x = d(); if (!x) return json({ error: "no such document" }, 404); x.path = x.path.replace("/.archive/", "/"); putBack("unarchived", x.path); return json({ unarchived: x.path, refinery: { refinery_id: null, archived: false } }); }
    // REAL (contracts/routes/idea_archive.ts:3,36-38; rw-idea-reopen-trail: ideas/repo.ts reopenIdea writes one 'reopened' trail line, no path, no text): by id, own ideas only; another user's or a missing idea is 404, one that is not archived 409.
    m = p.match(/^\/workbench\/ideas\/([^/]+)\/reopen$/);
    if (m) { const i = W.ideas[mode].find((x) => x.id === m[1]); if (!i) return json({ error: "no such idea" }, 404); if (i.status !== "archived") return json({ error: "not archived" }, 409); i.status = "engaged"; W.dtrail[mode].unshift({ id: "lo" + ++seq, kind: "reopened", path: null, idea_id: i.id, actor_sub: SUB[mode], trashed_at: null, created_at: new Date().toISOString() }); return json({ idea_id: i.id, status: "engaged", archived: false }); }
    if (p === "/workbench/documents/delete-forever") {
      if (b.confirm !== true) return json({ error: "confirm" }, 400);
      const x = d(); if (!x || !x.path.includes("/.trash/")) return json({ error: "no such document" }, 404);
      W.docs[mode] = W.docs[mode].filter((y) => y !== x);
      W.dtrail[mode].unshift({ id: "l" + ++seq + "x", kind: "delete_forever", path: x.path, actor_sub: SUB[mode], trashed_at: ago(H), created_at: new Date().toISOString() });
      return json({ deleted: x.path });
    }
    return json({ error: "not found" }, 404);
  });
}).listen(9000, () => console.log("stub up"));
