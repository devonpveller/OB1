// The fake back end of the Ideas screen (rwr-ideas): ONE module that the vitest suite (test/ideas.test.tsx) and the
// headless-Chromium lab (e2e/ideas.stub.mjs) both use, so the two never disagree about the server. It copies the real
// server's behaviour, with the code it copies named:
//   reads    GET /workbench/contract/ideas, /ideas/{id}     contracts/repo/ideas.ts ideas() / idea(): only the caller's
//            ideas (owner_sub = the subject); another user's idea is 404 {error:"no idea with this id"}, the same as a missing one
//   edit     POST /workbench/ideas/{id}/edit                ideas/repo.ts editIdea + init-idea-functions.sql idea_edit: unchanged
//            wording = outcome unchanged; archived = 409 refinery-archived; a new wording is the next revision, status dirty,
//            and the revision's research_job_id stays NULL until the request boundary forms its job (slot 580)
//   research POST /ideas/{id}/research-now, GET /ideas/{id}/research, POST .../research/approve|private   ideas/routes.ts, review.ts
//   archive  POST /workbench/ideas/{id}/archive | /reopen   ideas/repo.ts archiveIdea / reopenIdea (rwr-idea-archive-api):
//            archived_from remembers the state; 404 for a foreign or missing idea; 409 already-archived / not-archived
//   seed     POST /workbench/documents/seed {idea_id}       documents/seed.ts seedFromIdea: 409 with the path when the idea has its
//            document, 409 when archived, 201 {path} and the idea becomes promoted
//   doc id   GET /workbench/documents/state?path= and /resolve?id=   documents routes: the listing row's opaque id of one of the
//            caller's own idea documents (docs-fake's uid(path), the same id the documents fake gives it); anyone else's = 404
// The shell's own reads (whoami, auth/me, settings, the menu counts) answer here too, for the e2e lab.
// Test hooks (never reachable on the real server): see hook().

// ideas/review.ts NOT_WAITING and UNCONFIGURED, word for word
import { uid as docUid } from "./docs-fake.mjs";
export const NOT_WAITING = "this idea's research question is not waiting for you (it was decided, or the idea changed since)";
export const UNCONFIGURED = "the research service is not configured for the workspace (RESEARCH_URL, RESEARCH_WORKSPACE_KEY)";
export const ARCHIVED_MSG = "this idea's refinery is archived: reopen it from its document first";
const H = 3600 * 1000, D = 24 * H;

export function createFake({ now = () => Date.now() } = {}) {
  const iso = (msAgo = 0) => new Date(now() - msAgo).toISOString();
  const people = {
    alice: { sub: "u-alice", name: "Alice Lab" },
    bob: { sub: "u-bob", name: "Bob Builder" },
    nobody: { sub: "u-nobody", name: "Nina Nobody" },
  };
  let seq = 0;
  const uid = (p) => `${p}000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const ideas = new Map();
  const sessions = new Map();
  const research = new Map(); // idea id -> { state, candidate, failing }
  const log = [];
  // researchConfigured: the workspace's approval door to the research service (review.ts approveClient); the default install has none
  const state = { mode: "alice", failList: false, hang: false, researchConfigured: false, docState: "ok" }; // docState: ok | fail | noid

  function addIdea(owner, o) {
    const id = o.id ?? uid("a1");
    const created = o.created ?? iso(2 * D);
    const idea = {
      id, owner, title: o.title, status: o.status ?? "new", archived_from: null, thread_root: o.thread_root ?? null, origin: o.origin ?? "captured_idea",
      document: o.document ?? null, podcasts: o.podcasts ?? [], room: o.room ?? null, user_sources: o.user_sources ?? [],
      created_at: created, updated_at: o.updated ?? created,
      revisions: (o.revisions ?? [o.summary]).map((s, i) => ({ revision: i + 1, summary: s, research_job_id: o.jobs?.[i] ?? null, created_at: o.revAt?.[i] ?? created })),
    };
    idea.summary = idea.revisions[idea.revisions.length - 1].summary;
    ideas.set(id, idea);
    for (const [jid, q] of Object.entries(o.sessionQueries ?? {})) sessions.set(jid, { id: jid, idea: id, query: q, status: "done", created_at: created });
    return id;
  }
  const mine = (idea, who) => idea.owner === people[who].sub;
  const summary = (i) => ({
    id: i.id, title: i.title, state: "current", status: i.status, summary: i.summary, current_revision: i.revisions.length, updated_at: i.updated_at,
    document_path: i.document?.path ?? null, last_session_at: null, dossier_at: null, resurfaced_at: null,
  });
  const detail = (i) => ({
    id: i.id, title: i.title, state: "current", status: i.status, summary: i.summary, current_revision: i.revisions.length,
    created_at: i.created_at, updated_at: i.updated_at, revisions: i.revisions.map((r) => ({ ...r })),
    sessions: [...sessions.values()].filter((s) => s.idea === i.id).map((s) => ({ id: s.id, status: s.status, origin: "workbench", query: s.query, refinery_id: i.id, created_at: s.created_at, finished_at: s.created_at })),
    room: { state: i.room ? "current" : "not_opened", room_id: i.room ? "r-" + i.id : null, thread_root: i.thread_root, inlet: null, entries: i.room?.entries ?? 0, dossiers: 0 },
    refinery: {
      origin: { kind: i.origin, document_path: i.document?.path ?? null },
      members: { sessions: [], document: i.document, podcasts: i.podcasts, exports: [], room: null, chats: [] },
      user_sources: i.user_sources.map((u) => ({ source_id: u.id, refinery_id: i.id, status: "held", state: "held", title: u.title, url: null, revision: 1 })), archived: i.status === "archived",
    },
  });

  const NOT_FOUND = { status: 404, body: { error: "no idea with this id" } };
  const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const own = (id, who) => { const i = ID.test(id) ? ideas.get(id.toLowerCase()) : undefined; return i && mine(i, who) ? i : null; };
  const touch = (i) => { i.updated_at = iso(); };

  // The shell's reads, for the e2e lab (the vitest suite answers these itself).
  const UI = ["ui.locked_document", "ui.last_document", "ui.start_screen", "library.recent"];
  function shell(method, p, mode) {
    const w = people[mode];
    if (p === "/workbench/workspace/whoami") return { status: 200, body: { subject_sub: w.sub, actor_sub: w.sub, name: w.name } };
    if (p === "/workbench/auth/me") return { status: 200, body: { mode: "forward-auth", signed_in: true, kind: "user", subject_sub: w.sub, name: w.name } };
    if (p === "/workbench/settings" && method === "GET") return { status: 200, body: { admin: false, settings: UI.map((k) => ({ key: k, value: null, version: 0 })) } };
    if (p === "/workbench/intake/jobs") return { status: 200, body: { jobs: [] } };
    if (p === "/workbench/contract/cleanup/sources") return { status: 200, body: { sources: [], total: 0 } };
    if (p === "/workbench/contract/cleanup/reopen-candidates") return { status: 200, body: { candidates: [] } };
    if (p === "/workbench/contract/sessions") return { status: 200, body: { sessions: [] } };
    return null;
  }

  // handle(method, url, body, who): the answer { status, body } of the workbench for the person `who`
  function handle(method, url, body, who = state.mode) {
    const u = new URL(url, "http://x");
    const p = u.pathname;
    log.push({ method, url, who });
    const s = shell(method, p, who);
    if (s) return s;
    if (method === "GET" && p === "/workbench/contract/ideas") {
      if (state.failList) return { status: 500, body: { error: "internal" } };
      const rows = [...ideas.values()].filter((i) => mine(i, who)).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      return { status: 200, body: { ideas: rows.map(summary) } };
    }
    let m = p.match(/^\/workbench\/contract\/ideas\/([^/]+)$/);
    if (method === "GET" && m) { const i = own(decodeURIComponent(m[1]), who); return i ? { status: 200, body: detail(i) } : NOT_FOUND; }
    m = p.match(/^\/workbench\/ideas\/([^/]+)\/(edit|research-now|research|research\/approve|research\/private|archive|reopen)$/);
    if (m) {
      const rawId = decodeURIComponent(m[1]), verb = m[2];
      if (!ID.test(rawId)) return NOT_FOUND; // ideaId(): an id that cannot exist reads like one that does not
      // the routes parse the body BEFORE any ownership check (parseEdit / parseQuestion), and approve answers 502 when unconfigured first
      if (method === "POST" && verb === "edit" && !(typeof body?.summary === "string" && body.summary.trim())) return { status: 400, body: { error: "summary is the idea's new text" } };
      if (method === "POST" && (verb === "research/approve" || verb === "research/private") && !(typeof body?.question === "string" && body.question.trim())) return { status: 400, body: { error: "question is the text to research" } };
      if (method === "POST" && verb === "research/approve" && !state.researchConfigured) return { status: 502, body: { error: UNCONFIGURED, code: "research-unconfigured" } };
      const i = own(rawId, who);
      if (!i) return NOT_FOUND;
      if (verb === "research" && method === "GET") {
        const r = research.get(i.id);
        return { status: 200, body: r ? { idea_id: i.id, state: r.state, revision: i.revisions.length, job_id: r.job ?? null, updated_at: iso(), review: r.state === "awaiting_owner" ? { candidate: r.candidate, failing: r.failing, code: "refused", refusal: "refused" } : null }
          : { idea_id: i.id, state: "none", revision: null, job_id: null, review: null } };
      }
      if (method !== "POST") return { status: 404, body: { error: "not found" } };
      if (verb === "edit") {
        const text = body.summary.trim();
        if (i.status === "archived") return { status: 409, body: { error: ARCHIVED_MSG, code: "refinery-archived" } };
        if (text.toLowerCase() === i.summary.toLowerCase()) return { status: 200, body: { outcome: "unchanged", revision: i.revisions.length, title: i.title } };
        i.revisions.push({ revision: i.revisions.length + 1, summary: text, research_job_id: null, created_at: iso() });
        i.summary = text; i.status = "dirty"; touch(i);
        research.set(i.id, { state: "pending" });
        return { status: 200, body: { outcome: "changed", revision: i.revisions.length, title: i.title } };
      }
      if (verb === "research-now") {
        if (i.status === "archived") return { status: 409, body: { error: ARCHIVED_MSG, code: "refinery-archived" } };
        research.set(i.id, { state: "pending" });
        return { status: 202, body: { outcome: "queued", job_id: uid("b2") } };
      }
      if (verb === "archive") {
        if (i.status === "archived") return { status: 409, body: { error: "this idea is already archived", code: "already-archived" } };
        i.archived_from = i.status; i.status = "archived"; touch(i);
        return { status: 200, body: { idea_id: i.id, status: "archived", archived: true } };
      }
      if (verb === "reopen") {
        if (i.status !== "archived") return { status: 409, body: { error: "this idea is not archived", code: "not-archived" } };
        i.status = i.archived_from && i.archived_from !== "archived" ? i.archived_from : "engaged"; i.archived_from = null; touch(i);
        return { status: 200, body: { idea_id: i.id, status: i.status, archived: false } };
      }
      // research/approve and research/private: only while the owner's review waits
      const r = research.get(i.id);
      if (!r || r.state !== "awaiting_owner") return { status: 409, body: { error: NOT_WAITING, code: "not-awaiting-owner" } };
      research.set(i.id, { state: "queued", job: uid("b3") });
      return { status: verb === "research/approve" ? 202 : 202, body: { outcome: "queued", run: verb === "research/approve" ? "derived" : "private", job_id: research.get(i.id).job } };
    }
    if (method === "GET" && (p === "/workbench/documents/state" || p === "/workbench/documents/resolve")) {
      const want = p.endsWith("state") ? u.searchParams.get("path") : u.searchParams.get("id");
      const i = [...ideas.values()].find((x) => mine(x, who) && x.document && (p.endsWith("state") ? x.document.path === want : docUid(x.document.path) === want));
      if (!i || state.docState === "fail") return state.docState === "fail" ? { status: 500, body: { error: "internal" } } : NOT_FOUND;
      return { status: 200, body: { id: state.docState === "noid" ? undefined : docUid(i.document.path), path: i.document.path, listed: true, trashed: false, archived: false } };
    }
    if (method === "POST" && p === "/workbench/documents/seed") {
      const i = typeof body?.idea_id === "string" ? own(body.idea_id, who) : null;
      if (!i) return { status: 404, body: { error: "no idea with this id" } };
      if (i.document) return { status: 409, body: { error: "this refinery already has its document - go to document", path: i.document.path } };
      if (i.status === "archived") return { status: 409, body: { error: "this idea's refinery is archived: reopen it first" } };
      const path = `documents/${people[who].sub}/${i.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
      i.document = { path, title: i.title }; i.status = "promoted"; touch(i);
      return { status: 201, body: { path, title: i.title } };
    }
    return { status: 404, body: { error: "not found" } };
  }

  // test hooks: the request boundary forms a run for the idea's current revision; the owner's review is raised
  function hook(name, arg = {}) {
    if (name === "form-run") {
      const i = ideas.get(arg.id); const r = i.revisions[i.revisions.length - 1];
      const jid = uid("c3"); r.research_job_id = jid;
      sessions.set(jid, { id: jid, idea: i.id, query: arg.query ?? "a derived question", status: "running", created_at: iso() });
      research.set(i.id, { state: "queued", job: jid });
      return { job: jid };
    }
    if (name === "await-owner") { research.set(arg.id, { state: "awaiting_owner", candidate: arg.candidate ?? "a question", failing: arg.failing ?? ["a name"] }); return {}; }
    if (name === "research-state") { research.set(arg.id, { state: arg.state }); return {}; } // refused | delivered | failed | queued ...
    if (name === "configure-research") { state.researchConfigured = !!arg.on; return {}; }
    if (name === "mode") { state.mode = arg.mode; return {}; }
    if (name === "doc-state") { state.docState = arg.mode; return {}; }
    if (name === "fail-list") { state.failList = !!arg.on; return {}; }
    return { error: "no such hook" };
  }

  return { handle, hook, addIdea, ideas, sessions, log, people, state, iso, H, D };
}
