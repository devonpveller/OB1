// A fake of the workbench's document-gaps back end (rwr-doc-coverage): the vitest suite (test/coverage.test.tsx) and the e2e
// stub (e2e/coverage.stub.mjs) both drive THIS one, so the two cannot drift. It copies the real routes' behaviour as the app
// sees it (OB1/docker/workbench/src/contracts/routes/gaps.ts, repo/gaps.ts, schemas/gaps.ts, routes/http.ts fail(); and for
// "found by research" routes/trust.ts + repo/trust.ts documentCoverage / sessionCoverage):
//   - POST   /contract/gaps          strict body {path, text, origin?}; text 1..2000 CODE POINTS, no control characters, not blank
//                                    (400); origin a key of gap_origins (422); path = ONE documents/ path ending .md, at most 1024
//                                    bytes (400), the caller's own (a foreign or missing one is the one 404 "no such document");
//                                    a text that matches (normalised) an open / researching gap, or a dismissed gap of the SAME
//                                    origin, of the same document is 409 {error, detail:{existing}} naming the caller's OWN gap.
//   - GET    /contract/gaps          the caller's own gaps newest first, {gaps, total, counts}; dismissed only when asked.
//                                    Reading settles the caller's researching gaps whose run ended (covered, or back to open).
//   - GET/PATCH/DELETE /contract/gaps/<id>   the caller's own; another user's, a missing and a malformed id are ONE 404
//                                    {"error":"no such gap"}. PATCH text/state (a state "researching" is 400; a researching gap
//                                    cannot be reworded, 409); DELETE refuses a dismissed or researching gap (409).
//   - POST   /contract/gaps/research {ids}: 1..50 ids; all the caller's own (else ONE 404 "no such gap", before anything else is
//                                    said), all open (409), all of one document (400), the document LISTED (409 "the document is not
//                                    listed yet; save it first", the gaps stay open; modelled when `isListed` is given); ONE job, every gap researching with that
//                                    job id; 202 {job_id, gaps}. 503 when the research service is not configured.
//   - GET    /contract/documents/coverage?path=   {path, computed_at, hubs, sessions:[{id,status,created_at,by_status,credibility}]}
//                                    of the caller's own sessions for the document; path missing 400, not theirs 404.
//   - GET    /contract/sessions/<id>/coverage     {session_id,status,created_at,needs:[{need,status}],by_status,gaps:[string],...};
//                                    another user's and a missing session are ONE 404 {"error":"no session with this id"}.
// Identity is the `who` the caller passes ({sub, key}), never a body field. The fake is not the server: the server's own
// isolation is its lab's (contract-test/run-gaps-tests.ps1).
export const ORIGINS = ["user", "selection", "research", "scan", "topic"];
export const STATES = ["open", "researching", "covered", "dismissed"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLEAN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const ENCODED_DOTS = /^(?:\.|%(?:25)*2e){1,2}$/i;
const NO_GAP = { status: 404, body: { error: "no such gap" } };
const NO_DOC = { status: 404, body: { error: "no such document" } };
const NO_SESSION = { status: 404, body: { error: "no session with this id" } };

// repo/gaps.ts normalizeGapText
export function normalizeGapText(s) {
  return s.normalize("NFKC").toLowerCase().replace(/[​‌⁠﻿]/g, "").replace(/\s+/g, " ").trim()
    .replace(/^[\s"'“”‘’(\[{]+/, "").replace(/[\s"'“”‘’)\]}.,;:!?…]+$/, "");
}
// repo/gaps.ts singleDocumentPath (safeRelPath + documents/ + .md + 1024 bytes); null = the 400
export function singleDocumentPath(path) {
  const parts = String(path).replace(/\\/g, "/").split("/").filter((p) => p.length > 0 && p !== ".");
  if (!parts.length || parts.some((p) => p === ".." || ENCODED_DOTS.test(p) || /[\x00-\x1f\x7f]/.test(p))) return null;
  const norm = parts.join("/");
  if (!norm.startsWith("documents/") || norm.length <= "documents/".length || !norm.toLowerCase().endsWith(".md")) return null;
  if (new TextEncoder().encode(norm).length > 1024) return null;
  return norm;
}
const invalid = (message) => ({ status: 400, body: { error: "invalid request", detail: { issues: [{ message }] } } });
const bad = (m) => ({ status: 400, body: { error: m } });
const unreg = (registry, value) => ({ status: 422, body: { error: `'${value}' is not a registered ${registry}`, detail: { registry, value } } });
const byStatus = (needs) => { const o = { answered: 0, partial: 0, open: 0, search_failed: 0 }; for (const n of needs) o[n.status] = (o[n.status] ?? 0) + 1; return o; };

export function createGapsFake({ ownsDocument, isListed, now = () => Date.now() } = {}) {
  let rows = [];
  let seq = 0;
  let jobSeq = 0;
  let sessions = []; // planted research sessions (owner_sub, path, id, status, created_at, needs, gaps)
  let queue = "ok";  // "ok" | "off" (the research service is not configured: 503) | "fail" (queueing throws: 500, the gaps stay open)
  const runs = new Map(); // job id -> { status: running|done|error|cancelled, covers: Set(gap id) }
  const gapId = () => `9a900000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const iso = () => new Date(now()).toISOString();
  const shape = (r) => ({ id: r.id, path: r.path, text: r.text, origin: r.origin, state: r.state, job_id: r.job_id, covered_at: r.covered_at, created_at: r.created_at, updated_at: r.updated_at });
  const mine = (who) => rows.filter((r) => r.owner_sub === who.sub);
  // the document is the caller's own: their key directory, or a legacy file they hold the listing for (ownsDocumentPaths)
  const owns = (who, path) => {
    const seg = path.split("/")[1] ?? "";
    return seg === who.key || ((seg.endsWith(".md") || seg.startsWith(".")) && !!ownsDocument && ownsDocument(who, path));
  };
  const blocker = (who, path, norm, origin, exceptId) => mine(who).filter((r) => r.path === path && r.norm === norm && r.id !== exceptId
    && (r.state === "open" || r.state === "researching" || (r.state === "dismissed" && r.origin === origin)))
    .sort((a, b) => (a.state === "dismissed") - (b.state === "dismissed") || a.created_at.localeCompare(b.created_at))[0] ?? null;
  const refuse = (ex) => ({ status: 409, body: { error: ex.state === "dismissed" ? "this gap was dismissed from the same origin; reopen it instead" : "this gap is already on the list", detail: { existing: shape(ex) } } });
  const textIssue = (t) => typeof t !== "string" || t.length < 1 || Array.from(t).length > 2000 || CLEAN.test(t) || t.trim() === "";
  // the settle: a researching gap whose run ended is covered, or back to open (job_id kept)
  const settle = (who) => {
    for (const g of mine(who)) {
      if (g.state !== "researching" || !g.job_id) continue;
      const run = runs.get(g.job_id);
      if (run && run.status === "running") continue;
      const covered = !!run && run.status === "done" && run.covers.has(g.id);
      g.state = covered ? "covered" : "open";
      g.covered_at = covered ? iso() : null;
      g.updated_at = iso();
    }
  };

  // handle(who: {sub, key}, method, url, body) -> {status, body} | null (null: not a gaps / coverage route)
  function handle(who, method, url, body = {}) {
    const u = new URL(url, "http://x");
    const p = u.pathname;
    if (p === "/workbench/contract/documents/coverage" && method === "GET") {
      const path = u.searchParams.get("path");
      if (!path) return bad("path (the document's vault path) is required");
      const norm = path.replace(/\\/g, "/");
      if (!owns(who, norm)) return NO_DOC;
      const list = sessions.filter((s) => s.owner_sub === who.sub && s.path === norm).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
      return { status: 200, body: { path: norm, computed_at: iso(), hubs: [], sessions: list.map((s) => ({ id: s.id, status: s.status, created_at: s.created_at, by_status: byStatus(s.needs), credibility: "not scored" })) } };
    }
    const sm = /^\/workbench\/contract\/sessions\/([^/]+)\/coverage$/.exec(p);
    if (sm && method === "GET") {
      const id = decodeURIComponent(sm[1]);
      const s = UUID.test(id) ? sessions.find((x) => x.id === id.toLowerCase() && x.owner_sub === who.sub) : null;
      if (!s) return NO_SESSION;
      return { status: 200, body: { session_id: s.id, status: s.status, created_at: s.created_at, needs: s.needs.map((n) => ({ ...n })), by_status: byStatus(s.needs), gaps: [...s.gaps], topic_estimate: null, anchor: null, anchor_basis: "the session's own question (a root has no other anchor)", report_id: null, credibility: {}, hubs: [] } };
    }
    const m = /^\/workbench\/contract\/gaps(?:\/([^/]+))?$/.exec(p);
    if (!m) return null;
    const id = m[1] ? decodeURIComponent(m[1]) : null;
    if (!id && method === "POST") {
      if (!body || typeof body !== "object" || Array.isArray(body)) return bad("invalid request: the body must be a JSON object");
      if (Object.keys(body).some((k) => !["path", "text", "origin"].includes(k))) return invalid("unrecognized key");
      if (typeof body.path !== "string" || body.path.length < 1 || textIssue(body.text) || (body.origin !== undefined && typeof body.origin !== "string")) return invalid("bad field");
      if (new TextEncoder().encode(body.path).length > 1024 || CLEAN.test(body.path)) return invalid("bad path");
      const origin = body.origin ?? "user";
      if (!ORIGINS.includes(origin)) return unreg("gap_origins", origin);
      const path = singleDocumentPath(body.path);
      if (path === null) return bad("path must be a document path (documents/...)");
      if (!owns(who, path)) return NO_DOC;
      const text = body.text.trim();
      const norm = normalizeGapText(text);
      if (!norm) return bad("a gap needs some words");
      const dup = blocker(who, path, norm, origin);
      if (dup) return refuse(dup);
      const at = iso();
      const r = { id: gapId(), owner_sub: who.sub, path, text, norm, origin, state: "open", job_id: null, covered_at: null, created_at: at, updated_at: at };
      rows.push(r);
      return { status: 201, body: shape(r) };
    }
    if (!id && method === "GET") {
      const state = u.searchParams.get("state"), path = u.searchParams.get("path");
      if (state && !STATES.includes(state)) return unreg("gap_states", state);
      settle(who);
      const base = mine(who).filter((r) => !path || r.path === path.replace(/\\/g, "/"));
      const f = base.filter((r) => (state ? r.state === state : r.state !== "dismissed"));
      const counts = { open: 0, researching: 0, covered: 0, dismissed: 0 };
      for (const r of base) counts[r.state]++;
      const lim = Math.max(1, Math.min(500, Number(u.searchParams.get("limit") || 100)));
      const sorted = [...f].sort((a, b) => b.created_at.localeCompare(a.created_at) || (a.id < b.id ? -1 : 1));
      return { status: 200, body: { gaps: sorted.slice(0, lim).map(shape), total: f.length, counts } };
    }
    if (id === "research" && method === "POST") {
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "ids")) return invalid("unrecognized key");
      if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 50 || body.ids.some((i) => typeof i !== "string" || !UUID.test(i))) return invalid("bad ids");
      const want = [...new Set(body.ids.map((i) => i.toLowerCase()))];
      if (queue === "off") return { status: 503, body: { error: "the research service is not available for the workbench" } };
      const held = mine(who).filter((r) => want.includes(r.id));
      if (held.length !== want.length) return NO_GAP; // another user's gap and a missing one: the same refusal
      if (new Set(held.map((r) => r.path)).size !== 1) return bad("tick gaps of one document");
      if (held.some((r) => r.state !== "open")) return { status: 409, body: { error: "only open gaps can be researched", detail: {} } };
      // queueResearch (documents/refinery.ts): a document with no listing row cannot be researched; the gaps are put back to open
      if (isListed && !isListed(who, held[0].path)) return { status: 409, body: { error: "the document is not listed yet; save it first", detail: {} } };
      if (queue === "fail") return { status: 500, body: { error: "internal" } }; // the gaps stay open (the server puts them back)
      const job = `9a900000-0000-4000-8000-${String(0xa1 + ++jobSeq).padStart(12, "0")}`;
      runs.set(job, { status: "running", covers: new Set() });
      for (const r of held) { r.state = "researching"; r.job_id = job; r.updated_at = iso(); }
      const out = mine(who).filter((r) => r.job_id === job).sort((a, b) => a.created_at.localeCompare(b.created_at) || (a.id < b.id ? -1 : 1));
      return { status: 202, body: { job_id: job, gaps: out.map(shape) } };
    }
    if (!id) return { status: 405, body: { error: "method not allowed" } };
    if (!UUID.test(id)) return NO_GAP;
    if (method === "GET") {
      settle(who);
      const r = mine(who).find((x) => x.id === id);
      return r ? { status: 200, body: shape(r) } : NO_GAP;
    }
    if (method === "PATCH") {
      if (!body || typeof body !== "object" || Object.keys(body).some((k) => !["text", "state"].includes(k))) return invalid("unrecognized key");
      if (body.text !== undefined && textIssue(body.text)) return invalid("bad text");
      if (body.state !== undefined && typeof body.state !== "string") return invalid("bad state");
      if (body.text === undefined && body.state === undefined) return bad("give text or state");
      if (body.state !== undefined) {
        if (!STATES.includes(body.state)) return unreg("gap_states", body.state);
        if (body.state === "researching") return bad("a gap becomes researching only by researching it");
      }
      const cur = mine(who).find((x) => x.id === id);
      if (!cur) return NO_GAP;
      if (cur.state === "researching" && body.text !== undefined) return { status: 409, body: { error: "a gap that is being researched cannot be reworded", detail: {} } };
      const text = body.text !== undefined ? body.text.trim() : cur.text;
      const norm = normalizeGapText(text);
      if (!norm) return bad("a gap needs some words");
      const state = body.state ?? cur.state;
      if (state === "open" || state === "researching" || state === "dismissed") {
        const dup = blocker(who, cur.path, norm, cur.origin, id);
        if (dup) return refuse(dup);
      }
      cur.text = text; cur.norm = norm; cur.state = state; cur.updated_at = iso();
      cur.covered_at = state === "covered" ? (cur.covered_at ?? iso()) : null;
      return { status: 200, body: shape(cur) };
    }
    if (method === "DELETE") {
      const cur = mine(who).find((x) => x.id === id);
      if (!cur) return NO_GAP;
      if (cur.state === "dismissed") return { status: 409, body: { error: "a dismissed gap is kept so its origin cannot bring it back; reopen it instead", detail: {} } };
      if (cur.state === "researching") return { status: 409, body: { error: "a gap that is being researched cannot be removed", detail: {} } };
      rows = rows.filter((x) => x !== cur);
      return { status: 200, body: { id, deleted: true } };
    }
    return { status: 405, body: { error: "method not allowed" } };
  }
  return {
    handle,
    reset() { rows = []; seq = 0; jobSeq = 0; sessions = []; queue = "ok"; runs.clear(); },
    rows: () => rows,
    setQueue(v) { queue = v; },
    // a run that ended: the gaps it covered rotate out on the owner's next read; the others go back to open
    finishRun(job, { covers = [], status = "done" } = {}) { runs.set(job, { status, covers: new Set(covers) }); },
    plantSession(s) { sessions.push({ status: "done", created_at: iso(), gaps: [], needs: [], ...s }); },
    plantGap(owner, g) {
      const at = iso();
      const r = { id: gapId(), owner_sub: owner.sub, path: g.path, text: g.text, norm: normalizeGapText(g.text), origin: g.origin ?? "user", state: g.state ?? "open", job_id: g.job_id ?? null, covered_at: null, created_at: g.created_at ?? at, updated_at: at };
      rows.push(r);
      if (r.state === "researching" && r.job_id && !runs.has(r.job_id)) runs.set(r.job_id, { status: "running", covers: new Set() }); // a run that is still out
      return shape(r);
    },
  };
}
