// A fake of the workbench's Cleanup back end (rwr-cleanup): the vitest suite (test/cleanup.test.tsx) and the e2e stub
// (e2e/cleanup.stub.mjs) both drive THIS one, so the two cannot drift. It copies the real routes' behaviour as the app sees it
// (OB1/docker/workbench/src/contracts/routes/cleanup.ts, repo/cleanup.ts, routes/dismissals.ts, repo/dismissals.ts,
// schemas/dismissals.ts, routes/system.ts registry, routes/http.ts fail()):
//   - GET  /contract/cleanup/sources            shared (the same for every person): {sources, total}; each carries erase_allowed
//   - POST /contract/cleanup/sources/<id>/erase strict body {reason_type, note?}; reason_type a key of erasure_reasons (422);
//                                               404 for a missing source; 409 when erase is not allowed ("erase refused")
//   - POST /contract/cleanup/process-all        strict {reason_type, source_ids (1-500 uuids)}; ONE reason for the batch; per source:
//                                               erased | blocked | skipped (not listed); a note is refused (400)
//   - GET  /contract/cleanup/reopen-candidates  {candidates}: erased sources with evidence; erased_by_you is per viewer
//   - POST /contract/cleanup/tombstones/<id>/lift  only the eraser (403 otherwise); 404 for a missing marker
//   - GET  /contract/cleanup/dismissals         the caller's own {dismissals, total}; kind filter is a registry key (422)
//   - POST /contract/cleanup/dismissals         strict {kind, ref}; kind registry (422); ref 1-200 and no control characters (400);
//                                               the same thing twice is the same row; 201. The ref is NOT checked against anything.
//   - DELETE /contract/cleanup/dismissals/<id>  the caller's own only; another person's or a missing one is 404 "no such dismissal"
//   - GET  /contract/registries/<name>          {name, version, owner, description, entries:[{key, version, label, definition, ...}]}
//   - a flag decision is flags-fake.mjs (PATCH /contract/flags/<id>)
// Identity comes from the `who` the caller passes (the stub's mode), never from a body. The fake is not the server: the server's
// own isolation is its lab's.
import { REASONS as FLAG_REASONS } from "./flags-fake.mjs";

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CTRL = /[\u0000-\u001F\u007F]/;
export const ERASURE_REASONS = ["deliberate", "credibility", "debunked"];
export const DISMISSAL_KINDS = ["suggestion", "reopen_candidate"];
const AT = "2026-11-01T10:00:00.000Z";

// the library is shared: every title carries a marker so a leak is a string match
export const SRC = {
  ready1: "e1000000-0000-4000-8000-000000000001",
  ready2: "e1000000-0000-4000-8000-000000000002",
  ready3: "e1000000-0000-4000-8000-000000000003",
  blocked: "e1000000-0000-4000-8000-0000000000b1",
};
export const TOMB = { alice: "f1000000-0000-4000-8000-0000000000a1", bob: "f1000000-0000-4000-8000-0000000000b2" };

const registryEntry = (key) => ({ key, version: 1, label: key.replace(/_/g, " "), definition: {}, retired_at: null, superseded_by: null });

export function createCleanupFake({ now = () => Date.now(), flagReasons = FLAG_REASONS } = {}) {
  let sources, tombs, dismissals, seq;
  const reset = () => {
    seq = 0;
    sources = [
      { id: SRC.ready1, title: "SRC-SHARED ready one", url: "https://example.org/ready-one", lifecycle: "unlinked", reason: "duplicate of another", suppressed_at: AT, unlinked_at: AT, counts: {}, blocking: 0, severable: 0, total: 0, erase_allowed: true },
      { id: SRC.ready2, title: "SRC-SHARED ready two", url: "https://example.org/ready-two", lifecycle: "unlinked", reason: "misattributed quote", suppressed_at: AT, unlinked_at: AT, counts: { chunk: 2 }, blocking: 0, severable: 0, total: 2, erase_allowed: true },
      { id: SRC.ready3, title: "SRC-SHARED ready three", url: null, lifecycle: "unlinked", reason: "", suppressed_at: AT, unlinked_at: AT, counts: {}, blocking: 0, severable: 0, total: 0, erase_allowed: true },
      { id: SRC.blocked, title: "SRC-SHARED hidden, still used", url: "https://example.org/blocked", lifecycle: "suppressed", reason: "old", suppressed_at: AT, unlinked_at: null, counts: { claim_edge: 2, document_link: 1 }, blocking: 3, severable: 0, total: 3, erase_allowed: false },
    ];
    tombs = {
      [TOMB.alice]: { id: TOMB.alice, source_id: "a0000000-0000-4000-8000-0000000000a1", title: "SRC-SHARED erased by alice", url: "https://example.org/alice-gone", reason_type: "debunked", note: "wrong figures", erased_by: "u-alice", lifted: false, evidence: [{ note: "a new report cites it", reason: "re-scored 0.8 >= floor 0.5" }] },
      [TOMB.bob]: { id: TOMB.bob, source_id: "a0000000-0000-4000-8000-0000000000b2", title: "SRC-SHARED erased by bob", url: "https://example.org/bob-gone", reason_type: "credibility", note: "", erased_by: "u-bob", lifted: false, evidence: [{ note: null, reason: null }] },
    };
    dismissals = []; // { id, owner_sub, kind, ref, created_at }
  };
  reset();
  const bad = (m) => ({ status: 400, body: { error: m } });
  const invalid = (message) => ({ status: 400, body: { error: "invalid request", detail: { issues: [{ message }] } } });
  const unreg = (registry, value) => ({ status: 422, body: { error: `'${value}' is not a registered ${registry}`, detail: { registry, value } } });
  const strict = (b, allowed) => !b || typeof b !== "object" || Array.isArray(b) ? bad("invalid request: the body must be a JSON object") : Object.keys(b).some((k) => !allowed.includes(k)) ? invalid("unrecognized key") : null;
  const view = (s) => ({ ...s });

  // handle(who: {sub, key}, method, url, body) -> {status, body} | null (null: not a cleanup route)
  function handle(who, method, url, body = {}) {
    const u = new URL(url, "http://x");
    const p = u.pathname;
    if (method === "GET" && p === "/workbench/contract/cleanup/sources") {
      return { status: 200, body: { sources: sources.map(view), total: sources.length } };
    }
    let m = /^\/workbench\/contract\/cleanup\/sources\/([^/]+)\/erase$/.exec(p);
    if (m && method === "POST") {
      const e = strict(body, ["reason_type", "note"]); if (e) return e;
      if (typeof body.reason_type !== "string") return invalid("reason_type is required");
      if (!ERASURE_REASONS.includes(body.reason_type)) return unreg("erasure_reasons", body.reason_type);
      const s = sources.find((x) => x.id === decodeURIComponent(m[1]));
      if (!s) return { status: 404, body: { error: "no such source" } };
      if (!s.erase_allowed) return { status: 409, body: { error: "erase refused: the source is still connected" } };
      sources = sources.filter((x) => x !== s);
      const id = `f1000000-0000-4000-8000-${String(100 + ++seq).padStart(12, "0")}`;
      tombs[id] = { id, source_id: s.id, title: s.title, url: s.url ?? "", reason_type: body.reason_type, note: "", erased_by: who.sub, lifted: false, evidence: [] };
      return { status: 200, body: { tombstone_id: id, reason_type: body.reason_type, note: body.note ?? null } };
    }
    if (method === "POST" && p === "/workbench/contract/cleanup/process-all") {
      const e = strict(body, ["reason_type", "source_ids"]); if (e) return e;
      if (typeof body.reason_type !== "string" || !Array.isArray(body.source_ids)) return invalid("reason_type and source_ids are required");
      if (body.source_ids.length < 1 || body.source_ids.length > 500 || body.source_ids.some((x) => typeof x !== "string" || !UUIDISH.test(x))) return invalid("source_ids: 1 to 500 ids");
      if (!ERASURE_REASONS.includes(body.reason_type)) return unreg("erasure_reasons", body.reason_type);
      // the real repo (repo/cleanup.ts) lower-cases and de-duplicates the ids before it works through them
      const items = [...new Set(body.source_ids.map((x) => x.toLowerCase()))].map((sid) => {
        const s = sources.find((x) => x.id === sid);
        if (!s) return { source_id: sid, outcome: "skipped", severed: 0, blocking: 0, tombstone_id: null, detail: "the source is active, not suppressed or unlinked" };
        if (!s.erase_allowed) return { source_id: sid, outcome: "blocked", severed: 0, blocking: s.blocking, tombstone_id: null, detail: "a connection the sever tool cannot remove" };
        sources = sources.filter((x) => x !== s);
        const id = `f1000000-0000-4000-8000-${String(100 + ++seq).padStart(12, "0")}`;
        tombs[id] = { id, source_id: s.id, title: s.title, url: s.url ?? "", reason_type: body.reason_type, note: "", erased_by: who.sub, lifted: false, evidence: [] };
        return { source_id: sid, outcome: "erased", severed: 0, blocking: 0, tombstone_id: id, detail: null };
      });
      const erased = items.filter((i) => i.outcome === "erased").length;
      return { status: 200, body: { action: { id: "c1ea0000-0000-4000-8000-000000000001", kind: "process_all" }, reason_type: body.reason_type, items, erased } };
    }
    if (method === "GET" && p === "/workbench/contract/cleanup/reopen-candidates") {
      const cands = Object.values(tombs).filter((t) => !t.lifted && t.evidence.length > 0).map((t) => ({
        kind: t.reason_type === "debunked" ? "proposed_contesting" : "reopen_note",
        tombstone: { id: t.id, source_id: t.source_id, url: t.url, title: t.title, reason_type: t.reason_type, note: t.note || null, eraser_kind: "user", erased_by_you: t.erased_by === who.sub, erased_at: AT, confidence: null, score_version: null },
        evidence: t.evidence.map((ev) => ({ path: "intake", outcome: "candidate", session_id: null, note: ev.note, attempted_at: AT, reason: ev.reason, score: null })),
        dispute_preview: t.reason_type === "debunked" ? { criticism: { tombstone_id: t.id, reason_type: t.reason_type, note: t.note || null, erased_at: AT }, score: { available: true } } : null,
      }));
      return { status: 200, body: { candidates: cands } };
    }
    m = /^\/workbench\/contract\/cleanup\/tombstones\/([^/]+)\/lift$/.exec(p);
    if (m && method === "POST") {
      const t = tombs[decodeURIComponent(m[1])];
      if (!t) return { status: 404, body: { error: "no such tombstone" } };
      if (t.erased_by !== who.sub) return { status: 403, body: { error: "only the eraser or an administrator may lift it" } };
      t.lifted = true;
      return { status: 200, body: { action: { id: "c1ea0000-0000-4000-8000-000000000002", kind: "lift" }, tombstone_id: t.id, lifted_at: AT } };
    }
    // ---- dismissals (routes/dismissals.ts, repo/dismissals.ts)
    if (p === "/workbench/contract/cleanup/dismissals" && method === "GET") {
      const kind = u.searchParams.get("kind");
      if (kind && !DISMISSAL_KINDS.includes(kind)) return unreg("dismissal_kinds", kind);
      const mine = dismissals.filter((d) => d.owner_sub === who.sub && (!kind || d.kind === kind));
      const lim = Math.max(1, Math.min(1000, Number(u.searchParams.get("limit") || 500)));
      return { status: 200, body: { dismissals: mine.slice(0, lim).map(({ id, kind: k, ref, created_at }) => ({ id, kind: k, ref, created_at })), total: mine.length } };
    }
    if (p === "/workbench/contract/cleanup/dismissals" && method === "POST") {
      const e = strict(body, ["kind", "ref"]); if (e) return e;
      if (typeof body.kind !== "string" || typeof body.ref !== "string" || body.ref.length < 1 || body.ref.length > 200 || CTRL.test(body.ref)) return invalid("bad kind or ref");
      if (!DISMISSAL_KINDS.includes(body.kind)) return unreg("dismissal_kinds", body.kind);
      let d = dismissals.find((x) => x.owner_sub === who.sub && x.kind === body.kind && x.ref === body.ref);
      if (!d) { d = { id: `d15a0000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, owner_sub: who.sub, kind: body.kind, ref: body.ref, created_at: new Date(now()).toISOString() }; dismissals.push(d); }
      return { status: 201, body: { id: d.id, kind: d.kind, ref: d.ref, created_at: d.created_at } };
    }
    m = /^\/workbench\/contract\/cleanup\/dismissals\/([^/]+)$/.exec(p);
    if (m && method === "DELETE") {
      const id = decodeURIComponent(m[1]);
      const d = UUIDISH.test(id) ? dismissals.find((x) => x.id === id.toLowerCase() && x.owner_sub === who.sub) : null; // uuid compares case-free, as Postgres and the route's /i pattern do
      if (!d) return { status: 404, body: { error: "no such dismissal" } };
      dismissals = dismissals.filter((x) => x !== d);
      return { status: 200, body: { id } };
    }
    // ---- the registries (routes/system.ts): the flag reasons are THE flags fake's list, so the two cannot disagree
    m = /^\/workbench\/contract\/registries\/([^/]+)$/.exec(p);
    if (m && method === "GET") {
      const names = { flag_reasons: flagReasons, erasure_reasons: ERASURE_REASONS, dismissal_kinds: DISMISSAL_KINDS };
      const keys = names[decodeURIComponent(m[1])];
      if (!keys) return { status: 404, body: { error: "no such registry" } };
      return { status: 200, body: { name: decodeURIComponent(m[1]), version: 1, owner: "lab", description: "", entries: keys.map(registryEntry) } };
    }
    return null;
  }
  return {
    handle,
    reset,
    sources: () => sources,
    dismissals: () => dismissals,
    tombs: () => tombs,
    addSource(s) { sources.push(s); },
  };
}
