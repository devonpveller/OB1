// A fake back end for the Research runs screen (rwr-research-runs), shared by the vitest suite and the e2e stub. It applies the
// rules of the REAL routes (OB1/docker/workbench/src/contracts/repo/research_runs.ts, routes/research_runs.ts and, for steer /
// cancel / stream, routes/sessions.ts and routes/appendix.ts) so a screen cannot pass here on a behaviour the server does not have:
//   * a person's runs are the root jobs they own (owner = the identity's sub): another person's run is listed, counted, grouped,
//     opened, archived, turned into a document or steered NOWHERE - the same 404 body as a missing id;
//   * groupOf() / countsOf(): running (also a done root with an open branch) | queued | done | stopped; archived runs are counted
//     apart and never in a group or the total;
//   * archive / unarchive are PER PERSON (archivedBy holds subs); a repeat is 409; the run, sources and claims are untouched;
//   * node claims are only those still in the SHARED claims table (a claim moved to its owner's private store has no row there and
//     is never listed or counted); a node's sources are its flow + cited sources;
//   * the report becomes a document in the caller's own folder (201 {path, title}); no report yet is 409;
//   * steer: 404 unless the caller may act, 400 for a step the run does not have, 409 for a cancelled or errored run, 201 with the
//     new branch (queued); cancel: 404 unless the caller may act, 200 {status};
//   * the stream of ANOTHER person's run is the shared card: no prompt, no steer text, no step ids.
// It speaks the wire shapes only; the screen's fetch door (lib/api.ts) and the e2e stub's HTTP server are its two callers.

export const PREFIX = "/workbench/contract";
const NO_RUN = "no research run with this id";
const iso = (t) => new Date(t).toISOString();

export function groupOf(status, openBranches) {
  if (status === "queued") return openBranches > 0 ? "running" : "queued";
  if (status === "running" || openBranches > 0) return "running";
  if (status === "done") return "done";
  return "stopped";
}

export function createRunsFake(opts = {}) {
  const now = opts.now ?? (() => Date.now());
  let seq = 0;
  const id = (p = "f") => `${p}0000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const state = {
    runs: [], // { id, owner, question, topic, document, status, created, finished, canAct, steps: [..], nodes: [] }
    sharedClaims: new Map(), // id -> text (the SHARED claims table)
    docs: [], // { owner, path, title, body }
    listeners: new Map(), // run id -> Set of (event) callbacks (the stream)
    steerSteps: new Map(),
  };

  function addRun(r) {
    const run = {
      id: r.id ?? id("a"), owner: r.owner, question: r.question, topic: r.topic ?? null, document: r.document ?? null,
      status: r.status ?? "done", created: r.created ?? now() - 3600_000, finished: r.finished ?? (r.status === "running" || r.status === "queued" ? null : now() - 1800_000),
      canAct: r.canAct ?? true, step: r.step === undefined ? "step-1" : r.step, report: r.report ?? "", archivedBy: new Set(r.archivedBy ?? []),
      nodes: [],
    };
    run.nodes.push({ id: run.id, parent: null, kind: "root", status: run.status, query: run.question, created: run.created, sources: r.sources ?? [], claims: r.claims ?? [], report: run.report, rooted: null });
    for (const n of r.nodes ?? []) addNode(run, n);
    state.runs.push(run);
    return run;
  }
  function addNode(run, n) {
    const node = { id: n.id ?? id("b"), parent: n.parent ?? run.id, kind: n.kind ?? "steer", status: n.status ?? "queued", query: n.query ?? "", created: n.created ?? now(), sources: n.sources ?? [], claims: n.claims ?? [], report: n.report ?? "", rooted: n.rooted ?? null };
    run.nodes.push(node);
    return node;
  }
  const find = (rid) => state.runs.find((x) => x.id === rid);
  const openOf = (run) => run.nodes.filter((n) => n.id !== run.id && (n.status === "queued" || n.status === "running")).length;
  const rowOf = (run, sub) => ({
    id: run.id, question: run.question, topic: run.topic, document: run.document, status: run.status,
    group: groupOf(run.status, openOf(run)), branches: run.nodes.length - 1, created_at: iso(run.created),
    finished_at: run.finished ? iso(run.finished) : null, archived: run.archivedBy.has(sub), archived_at: run.archivedBy.has(sub) ? iso(now()) : null,
  });
  const mineOf = (sub) => state.runs.filter((r) => r.owner === sub).sort((a, b) => b.created - a.created);
  function countsOf(rows) {
    const c = { running: 0, queued: 0, done: 0, stopped: 0, archived: 0, total: 0 };
    for (const r of rows) { if (r.archived) { c.archived++; continue; } c[r.group]++; c.total++; }
    return c;
  }
  const notFound = () => ({ status: 404, body: { error: NO_RUN } });
  const treeOf = (run, sub) => run.nodes.map((n) => ({
    id: n.id, parent_job_id: n.parent, branch_kind: n.kind, status: n.status, open: n.status === "queued" || n.status === "running",
    pending: n.id !== run.id && n.status === "queued", rooted_step_id: run.owner === sub ? n.rooted : null, query: n.query, created_at: iso(n.created),
    sources: n.sources.map((s) => ({ url: s.url, title: s.title ?? null, stages: s.stages ?? [] })),
    // a claim is listed only while it still has a row in the SHARED claims table (a claim drawn from a private report has none)
    claims: n.claims.filter((c) => state.sharedClaims.has(c.id)).map((c) => ({ id: c.id, text: state.sharedClaims.get(c.id) })),
    has_report: !!n.report,
  }));

  /** One request. `sub` = the signed-in subject (the identity seam). Returns { status, body }. */
  function handle(method, url, body, sub) {
    const u = new URL(url, "http://x");
    const p = u.pathname;
    method = method.toUpperCase();
    if (p === `${PREFIX}/research/runs` && method === "GET") {
      const v = u.searchParams.get("view");
      const view = v === "archived" || v === "all" ? v : "active";
      const all = mineOf(sub).map((r) => rowOf(r, sub));
      const lim = Math.min(1000, Math.max(1, Number(u.searchParams.get("limit") ?? 200) || 200));
      return { status: 200, body: { runs: all.filter((r) => view === "all" || (view === "archived") === r.archived).slice(0, lim), counts: countsOf(all) } };
    }
    let m = p.match(new RegExp(`^${PREFIX}/research/runs/([^/]+)(?:/(archive|unarchive|document))?$`));
    if (m) {
      const run = find(m[1]);
      const own = run && run.owner === sub ? run : null;
      if (!m[2] && method === "GET") {
        if (!own) return notFound();
        return { status: 200, body: { run: rowOf(own, sub), can_act: own.canAct, running: own.status === "queued" || own.status === "running" || openOf(own) > 0,
          next_steering_point: own.step ? { step_id: own.step, phase: "searching" } : null, nodes: treeOf(own, sub) } };
      }
      if (method === "POST" && (m[2] === "archive" || m[2] === "unarchive")) {
        if (!own) return notFound();
        const has = own.archivedBy.has(sub);
        if (m[2] === "archive") { if (has) return { status: 409, body: { error: "this run is already archived" } }; own.archivedBy.add(sub); }
        else { if (!has) return { status: 409, body: { error: "this run is not archived" } }; own.archivedBy.delete(sub); }
        return { status: 200, body: { id: own.id, archived: own.archivedBy.has(sub), archived_at: own.archivedBy.has(sub) ? iso(now()) : null } };
      }
      if (method === "POST" && m[2] === "document") {
        if (!own) return notFound();
        if (!own.report) return { status: 409, body: { error: "this run has no report yet" } };
        const title = own.question.replace(/\s+/g, " ").trim().slice(0, 120) || "Research report";
        const path = `documents/${sub}/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}${state.docs.length ? "-" + (state.docs.length + 1) : ""}.md`;
        state.docs.push({ owner: sub, path, title, body: own.report, id: id("c") });
        return { status: 201, body: { path, title } };
      }
    }
    m = p.match(new RegExp(`^${PREFIX}/sessions/([^/]+)/(steer|cancel)$`));
    if (m && method === "POST") {
      const run = find(m[1]);
      if (!run || run.owner !== sub || !run.canAct) return { status: 404, body: { error: "no session with this id" } };
      if (m[2] === "cancel") {
        if (run.status === "queued" || run.status === "running") { run.status = "cancelled"; run.nodes[0].status = "cancelled"; run.finished = now(); }
        for (const n of run.nodes) if (n.id !== run.id && (n.status === "queued" || n.status === "running")) n.status = "cancelled";
        emit(run.id);
        return { status: 200, body: { job_id: run.id, status: run.status === "cancelled" ? "cancelled" : run.status } };
      }
      if (run.status === "cancelled" || run.status === "error") return { status: 409, body: { error: `a ${run.status} session is not steered` } };
      if (!body || typeof body.text !== "string" || !body.text.trim() || typeof body.step_id !== "string") return { status: 400, body: { error: "invalid request" } };
      if (body.step_id !== run.step) return { status: 400, body: { error: "this session has no such step" } };
      const child = addNode(run, { kind: "steer", status: "queued", query: body.text, parent: run.id, rooted: body.step_id });
      run.steers = (run.steers ?? 0) + 1;
      emit(run.id);
      return { status: 201, body: { steer: { steer_id: id("d"), child_job_id: child.id, root_job_id: run.id, parent_job_id: run.id, step_id: body.step_id, steer_kind: "human" }, card: {} } };
    }
    m = p.match(new RegExp(`^${PREFIX}/sessions/([^/]+)/stream$`));
    if (m && method === "GET") {
      const run = find(m[1]);
      if (!run) return { status: 404, body: { error: "no session with this id" } };
      return { status: 200, stream: true, run, mine: run.owner === sub };
    }
    m = p.match(/^\/workbench\/documents\/state$/);
    if (m && method === "GET") {
      const d = state.docs.find((x) => x.owner === sub && x.path === u.searchParams.get("path"));
      return d ? { status: 200, body: { id: d.id, path: d.path, listed: true, trashed: false, archived: false } } : { status: 404, body: { error: "not found" } };
    }
    return null; // not a route of this fake
  }

  function cardEvent(run, mine) {
    const tree = run.nodes.map((n) => ({ id: n.id, parent_job_id: n.parent, branch_kind: n.kind, status: n.status, open: n.status === "queued" || n.status === "running", query: mine ? n.query : "" }));
    const card = { id: run.id, status: run.status, state: run.status === "queued" || run.status === "running" || openOf(run) > 0 ? "loading" : "current", query: mine ? run.question : "", tree, can_act: mine && run.canAct, mine };
    return { event: "card", session: { id: run.id, status: run.status, query: mine ? run.question : "" }, card, events: [] };
  }
  /** The SSE text of the run's current card, as the stream route writes it. */
  function sse(run, mine, name = "card") {
    const ev = name === "end" ? { event: "end", session_id: run.id } : cardEvent(run, mine);
    return `event: ${name}\ndata: ${JSON.stringify(ev)}\n\n`;
  }
  function emit(runId) {
    for (const f of state.listeners.get(runId) ?? []) f();
  }
  function listen(runId, f) {
    const s = state.listeners.get(runId) ?? new Set();
    s.add(f);
    state.listeners.set(runId, s);
    return () => s.delete(f);
  }
  /** Add a node to a run (a fixture run "grows") and tell the open streams. */
  function grow(runId, n) {
    const run = find(runId);
    const node = addNode(run, n);
    emit(runId);
    return node;
  }
  function finish(runId, status = "done") {
    const run = find(runId);
    run.status = status; run.nodes[0].status = status; run.finished = now();
    for (const n of run.nodes) if (n.status === "running" || n.status === "queued") n.status = status;
    emit(runId);
  }
  return { state, addRun, addNode, handle, sse, cardEvent, listen, emit, grow, finish, find, rowOf, id };
}
