// A fake of the workbench's intake routes for the Imports screen's tests (rwr-imports): the SAME logic runs behind the
// vitest fetcher and the e2e stub, so the two cannot drift from each other, and it copies the REAL server's answers
// (workbench/src/intake/routes.ts, repo.ts, pipeline.ts; documents/repo.ts owned()): same JSON shapes, same status
// codes, same refusal texts, and 404 {"error":"no such job"} for another person's job exactly as for a missing one.
// test/imports-drift.test.ts reads the server's source and fails when a constant or a message here stops matching it.
// WHO is the identity seam's subject (a string); a request body never names one.

import { uid } from "./docs-fake.mjs";

export const ACTIVE = ["queued", "fetching", "extracting", "embedding", "linking", "holding"];
export const CANCELLABLE = ["queued", "fetching", "extracting"];
export const KINDS = ["import", "add", "chunk", "extract", "entity"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// rwr-imports-server-api: a job is retried ONCE (intake/repo.ts MAX_ATTEMPTS, RETRIED_ALREADY)
export const MAX_ATTEMPTS = 2;
export const RETRIED_ALREADY = "this job was already retried once, so it cannot be retried again: add the link or file again as a new item";

export function actionsOf(status) {
  if (CANCELLABLE.includes(status)) return { actions: ["cancel"], primary: "cancel" };
  if (ACTIVE.includes(status)) return { actions: [], primary: "wait" };
  if (status === "failed" || status === "cancelled") return { actions: ["retry"], primary: "retry" };
  return { actions: [], primary: "open" };
}

export function createFake() {
  let n = 0;
  const jobs = new Map();
  const docs = []; // { owner, path, title, refinery: bool }
  const ideas = []; // { owner, id, title, status }
  const inlets = []; // { owner, kind, created } - the caller's own connections (slot 600's inlet_connections_of)
  const log = []; // every call the fake answered: { who, method, path }
  const id = () => "00000000-0000-4000-8000-" + String(++n).padStart(12, "0");
  const iso = (ms) => new Date(ms).toISOString();
  const str = (v) => (v == null ? "" : String(v));

  const seed = (owner, f = {}) => {
    const now = Date.now();
    const j = { id: id(), owner, mode: "add", origin: "workspace", status: "held", url: null, filename: null, content_type: null, refinery_id: null, doc_path: null,
      source_id: null, held_source_id: null, error: null, attempts: 1, created: now, updated: now, ...f };
    if (typeof j.created === "string") j.created = Date.parse(j.created);
    if (typeof j.updated === "string") j.updated = Date.parse(j.updated);
    jobs.set(j.id, j);
    return j;
  };
  const shape = (j) => ({
    kind: j.mode, id: j.id, status: j.status, state: ACTIVE.includes(j.status) ? "loading" : "current", created_at: iso(j.created), updated_at: iso(j.updated),
    detail: { mode: j.mode, origin: j.origin, source_id: j.source_id, target_notebook: null, error: j.error, staged: false, committed: false, duplicate: false,
      url: j.url, filename: j.filename, content_type: j.content_type, refinery_id: j.refinery_id, doc_path: j.doc_path, held_source_id: j.held_source_id, attempts: j.attempts,
      phase: j.status, ...actionsOf(j.status) },
  });
  const mine = (who, kind, jid) => {
    const j = UUID.test(jid) ? jobs.get(String(jid).toLowerCase()) : null;
    return j && j.owner === who && j.mode === kind ? j : null;
  };
  const touch = (j, f) => Object.assign(j, f, { updated: Date.now() });
  // the test's own control of the pipeline (the real one runs in the server): move a job along
  const set = (jid, status, error = null) => touch(jobs.get(jid), { status, error });

  function handle({ who, method, path, query = {}, json = {}, form = null }) {
    log.push({ who, method, path });
    let m;
    if (method === "GET" && path === "/workbench/intake/jobs") {
      const kinds = str(query.kinds).split(",").map((k) => k.trim()).filter(Boolean);
      const bad = kinds.filter((k) => !KINDS.includes(k));
      if (bad.length) return { status: 400, body: { error: `not a queue the panel shows: ${bad.join(", ")}`, kinds: KINDS } };
      const lim = Math.min(Math.max(parseInt(query.limit ?? "", 10) || 50, 1), 200);
      const out = [];
      for (const k of ["import", "add"]) {
        if (kinds.length && !kinds.includes(k)) continue;
        out.push(...[...jobs.values()].filter((j) => j.owner === who && j.mode === k && (!query.state || j.status === query.state))
          .sort((a, b) => b.created - a.created).slice(0, lim).map(shape));
      }
      out.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      return { status: 200, body: { jobs: out } };
    }
    if (method === "POST" && (m = path.match(/^\/workbench\/intake\/jobs\/([a-z]+)\/([^/]+)\/(retry|cancel)$/))) {
      const [, kind, jid, verb] = m;
      const j = KINDS.includes(kind) ? mine(who, kind, decodeURIComponent(jid)) : null;
      if (!j) return { status: 404, body: { error: "no such job" } };
      if (verb === "cancel") {
        if (!actionsOf(j.status).actions.includes("cancel")) return { status: 409, body: { error: `a ${j.status} ${j.mode} job cannot be cancelled` } };
        touch(j, { status: "cancelled", error: "cancelled by the user" });
        return { status: 200, body: { job: shape(j) } };
      }
      if (!actionsOf(j.status).actions.includes("retry")) return { status: 409, body: { error: `a ${j.status} ${j.mode} job cannot be retried` } };
      if (j.attempts >= MAX_ATTEMPTS) return { status: 409, body: { error: RETRIED_ALREADY } };
      touch(j, { status: "queued", error: null, attempts: j.attempts + 1 });
      return { status: 202, body: { job: shape(j) } };
    }
    if (method === "POST" && path === "/workbench/intake/add") {
      const b = form ?? json;
      const url = str(b.url).trim(), refineryId = str(b.refinery_id).trim(), dpath = str(b.path).trim();
      const file = form && b.file && typeof b.file === "object" ? b.file : null;
      if (!url && !file) return { status: 400, body: { error: "a link or a file is required" } };
      if (url && file) return { status: 400, body: { error: "a link or a file, not both" } };
      if (url) {
        let u = null;
        try { u = new URL(url); } catch { /* below */ }
        if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return { status: 400, body: { error: "the link must be an http or https address" } };
      }
      if (refineryId && dpath) return { status: 400, body: { error: "a refinery or a document, not both" } };
      const my = ideas.filter((i) => i.owner === who && i.status !== "archived").map((i) => ({ id: i.id, title: i.title }));
      if (!refineryId && !dpath) return { status: 400, body: { error: "choose the refinery it joins (a user add lands only in an existing idea refinery)", needs: "refinery_id", refineries: my } };
      let docPath = null;
      if (refineryId) {
        if (!my.some((x) => x.id === refineryId.toLowerCase())) return { status: 404, body: { error: "no such refinery (an add joins one of your existing refineries)" } };
      } else {
        const d = docs.find((x) => x.path === dpath);
        if (!d || d.owner !== who) return { status: 404, body: { error: "no such document" } };
        if (!d.refinery) return { status: 409, body: { error: "this document has no open refinery: open the document's refinery first (a user source lands only in an existing refinery)" } };
        docPath = dpath;
      }
      if (file) {
        const name = str(file.name).toLowerCase();
        const head = str(file.head).trimStart().toLowerCase();
        const type = head.startsWith("%pdf-") ? "pdf" : /\.(html?|xhtml)$/.test(name) && head.startsWith("<") ? "web_article" : null;
        if (!type) return { status: 415, body: { error: "a file add is a PDF or a saved web page (a YouTube transcript is added by its link)", content_types: ["web_article", "pdf", "youtube_transcript"] } };
      }
      const j = seed(who, { mode: "add", status: "queued", url: url || null, filename: file ? file.name : null, refinery_id: refineryId ? refineryId.toLowerCase() : null, doc_path: docPath });
      return { status: 202, body: { job_id: j.id, kind: "add", status: "queued", origin: "workspace" } };
    }
    if (method === "GET" && path === "/workbench/contract/inlets/connections") {
      // kind and stamps only, the caller's rows only (slot 600); a person with none gets an empty list
      return { status: 200, body: { connections: inlets.filter((i) => i.owner === who).sort((a, b) => a.created - b.created).map((i) => ({ kind: i.kind, created_at: iso(i.created), updated_at: iso(i.created) })) } };
    }
    if (method === "GET" && path === "/workbench/documents/state") {
      // as the documents route: the caller's own listed document answers with its opaque id; another person's is the same 404 as a missing one
      const d = docs.find((x) => x.owner === who && x.path === query.path);
      return d ? { status: 200, body: { id: uid(d.path), path: d.path, listed: true, trashed: /(^|\/)\.trash\//.test(d.path), archived: /(^|\/)\.archive\//.test(d.path), carries_idea: false, refinery: null, tags: [] } } : { status: 404, body: { error: "no such document" } };
    }
    if (method === "GET" && path === "/workbench/contract/documents") {
      return { status: 200, body: { documents: docs.filter((d) => d.owner === who).map((d) => ({ title: d.title, path: d.path, updated: iso(Date.now()), outbound_links: [] })) } };
    }
    if (method === "GET" && path === "/workbench/contract/ideas") {
      return { status: 200, body: { ideas: ideas.filter((i) => i.owner === who).map((i) => ({ id: i.id, title: i.title, status: i.status, updated_at: iso(Date.now()) })) } };
    }
    return null;
  }
  return { handle, seed, set, jobs, docs, ideas, inlets, log, shape };
}
