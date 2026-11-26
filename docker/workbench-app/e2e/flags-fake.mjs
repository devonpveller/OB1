// A fake of the workbench's flags back end (rwr-flag-buttons): the vitest suite (test/flag-buttons.test.tsx) and the e2e
// stub (e2e/flags.stub.mjs) both drive THIS one, so the two cannot drift. It copies the real routes' behaviour as the app
// sees it (OB1/docker/workbench/src/contracts/routes/flags.ts, repo/flags.ts, schemas/flags.ts, routes/http.ts fail()):
//   - POST   /contract/flags   strict body (an unknown field is 400, and so is a missing one); reason, item kind and from
//                              kind must be keys of their registry (422); note at most 2000 characters and no control
//                              characters (400); the flagged item must exist (404 "no such <kind>"; a reference into
//                              ANOTHER user's held source is that same 404); `from` is a document of the caller's own
//                              (a missing or foreign one is the one 404 "no such document") or a source that exists in the
//                              shared library (404 "no such source"). 201 with the flag as recorded.
//   - GET    /contract/flags   the caller's own flags newest first, {flags, total} (total = the caller's own count, not the
//                              page); scope=all is for admins (403 otherwise) and adds flagged_by; state / item_kind filters.
//   - GET    /contract/flags/<id>   the caller's own (any, for an admin); another user's is 404 {"error":"no such flag"},
//                              the same body as a missing or malformed id.
//   - PATCH  /contract/flags/<id>   the caller's own only: reason, note, or state withdrawn; another user's is that 404.
//   - A flag NEVER changes the flagged item: the fake keeps the items in read-only tables and `itemsSnapshot()` lets a test
//     compare them before and after.
// Identity comes from the `who` the caller passes (the stub's mode), never from a body. The fake is not the server: the
// server's own isolation is its lab's (contract-test/run-flags-tests.ps1).
export const REASONS = ["wrong_claim", "low_quality", "duplicate", "other"];
export const ITEM_KINDS = ["source", "claim", "reference"];
export const FROM_KINDS = ["document", "source"];
export const STATES = ["open", "withdrawn"];
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const NO_FLAG = { status: 404, body: { error: "no such flag" } };

// Planted shared items (the marker SRC-ALPHA / CLAIM-ALPHA is in every title so a leak is a string match).
export const ITEMS = {
  source: [
    { id: "b1000000-0000-4000-8000-0000000000a1", title: "SRC-ALPHA Socket guide" },
    { id: "b1000000-0000-4000-8000-0000000000b2", title: "SRC-ALPHA Whole source" },
  ],
  claim: [{ id: "c1000000-0000-4000-8000-0000000000a1", title: "CLAIM-ALPHA the socket takes 165 W" }],
  reference: [
    { id: "a1000000-0000-4000-8000-0000000000a1", title: "ref A" },
    { id: "a1000000-0000-4000-8000-0000000000b2", title: "ref B" },
    // a reference into a HELD source of the person named in `heldBy` (repo/flags.ts FOREIGN_HELD_TARGET): 404 for anyone else
    { id: "a1000000-0000-4000-8000-0000000000c3", title: "ref C", heldBy: "u-alice" },
  ],
};

// A COPY of the server's path checks (workbench/src/documents/ownership.ts: normalize, singleDocumentPath, documentPathsIn,
// isDocumentsPath, ownsDocumentPaths; used by contracts/repo/flags.ts checkFrom). checkFrom reads from.ref WHOLE through
// singleDocumentPath (rw-doc-path-spaces), so a folder named "Old notes" or "R&D" is a path like any other. documentPathsIn
// (the scanner, which stops a path at a space or at  " ' ? & # , ) ) stays here only because the server still has it.
// Keep both equal to the server's: do NOT make the fake kinder than the server.
const normalize = (p) => {
  const out = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
};
const isDocumentsPath = (p) => p.slice(0, "documents".length + 1).toLowerCase() === "documents/";
// A field that holds exactly one path: the whole string, no `..`/`.`/empty segment, no control character (ownership.ts singleDocumentPath)
export function singleDocumentPath(ref) {
  if (typeof ref !== "string" || CTRL_ANY.test(ref)) return null;
  const p = ref.replace(/\\/g, "/");
  if (!p.startsWith("documents/") || p.length <= "documents/".length) return null; // exactly lower case
  if (p.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || ENCODED_DOTS.test(seg))) return null;
  return p;
}
const ENCODED_DOTS = /^(?:\.|%(?:25)*2e){1,2}$/i; // util/paths.ts
const CTRL_ANY = /[\x00-\x1f\x7f]/;
export function documentPathsIn(s) {
  const found = [];
  const t = s.replace(/\\/g, "/");
  const re = /(^|[\/\s"'=:(,])((?:\.{1,2}\/)*documents\/[^\s"'?&#,)]*)/gi;
  for (const m of t.matchAll(re)) found.push(m[2]);
  for (const m of t.matchAll(/[^\s"'?&#,]*\.\.[^\s"'?&#,]*/g)) {
    const n = normalize(m[0]);
    if (isDocumentsPath(n)) found.push(n);
  }
  return [...new Set(found.map(normalize).filter((p) => isDocumentsPath(p) && p.length > "documents/".length))];
}

export function createFlagsFake({ ownsDocument, admins = [], now = () => Date.now() } = {}) {
  let rows = [];
  let seq = 0;
  let adminSubs = new Set(admins);
  const planted = new Set(); // extra existing source ids
  const itemsSnapshot = () => JSON.stringify(ITEMS);
  const flagId = () => `f1a90000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const shape = (r, withOwner) => ({
    id: r.id, item_kind: r.item_kind, item_id: r.item_id, reason: r.reason, note: r.note,
    from: { kind: r.from_kind, ref: r.from_ref }, state: r.state, created_at: r.created_at, updated_at: r.updated_at,
    flagged_by: withOwner ? r.owner_sub : null,
  });
  const bad = (m) => ({ status: 400, body: { error: m } });
  const invalid = (message) => ({ status: 400, body: { error: "invalid request", detail: { issues: [{ message }] } } });
  const unreg = (registry, value) => ({ status: 422, body: { error: `'${value}' is not a registered ${registry}`, detail: { registry, value } } });
  const exists = (kind, id, sub) => {
    const t = ITEMS[kind]?.find((x) => x.id === id);
    if (!t) return false;
    return !(kind === "reference" && t.heldBy && t.heldBy !== sub);
  };

  // handle(who: {sub, key}, method, url, body) -> {status, body} | null (null: not a flags route)
  function handle(who, method, url, body = {}) {
    const u = new URL(url, "http://x");
    const m = /^\/workbench\/contract\/flags(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return null;
    const id = m[1] ? decodeURIComponent(m[1]) : null;
    const admin = adminSubs.has(who.sub);
    if (!id && method === "POST") {
      const allowed = ["item_kind", "item_id", "reason", "note", "from"];
      if (!body || typeof body !== "object" || Array.isArray(body)) return bad("invalid request: the body must be a JSON object");
      if (Object.keys(body).some((k) => !allowed.includes(k))) return invalid("unrecognized key");
      for (const k of ["item_kind", "item_id", "reason", "from"]) if (body[k] === undefined) return invalid(`${k} is required`);
      const f = body.from;
      if (!f || typeof f !== "object" || Object.keys(f).some((k) => !["kind", "ref"].includes(k)) || typeof f.kind !== "string" || typeof f.ref !== "string" || f.ref.length < 1 || f.ref.length > 1024 || CTRL.test(f.ref)) return invalid("bad from");
      if (typeof body.item_kind !== "string" || typeof body.reason !== "string" || typeof body.item_id !== "string" || !UUIDISH.test(body.item_id)) return invalid("bad field");
      if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 2000 || CTRL.test(body.note))) return invalid("bad note");
      if (!ITEM_KINDS.includes(body.item_kind)) return unreg("flag_item_kinds", body.item_kind);
      if (!REASONS.includes(body.reason)) return unreg("flag_reasons", body.reason);
      if (!FROM_KINDS.includes(f.kind)) return unreg("flag_from_kinds", f.kind);
      // checkFrom: where the flag was made must be the flagger's own document, or a source that exists
      if (f.kind === "document") {
        // repo/flags.ts checkFrom, as the server has it: the whole ref is one documents/ path (backslashes read as slashes)
        const one = singleDocumentPath(f.ref);
        if (one === null) return bad("from.ref must be a path inside your own documents");
        const paths = [one];
        // ownsDocumentPaths: the caller's own key directory is theirs (existence is NOT checked); a legacy documents/<file>.md
        // or documents/.x is theirs only if its listing row is (the callback); any other key is not
        const seg = paths[0].split("/")[1] ?? "";
        const mine = seg === who.key || ((seg.endsWith(".md") || seg.startsWith(".")) && ownsDocument && ownsDocument(who, paths[0]));
        if (!mine) return { status: 404, body: { error: "no such document" } };
      } else {
        if (!UUIDISH.test(f.ref)) return bad("from.ref must be a source id");
        if (!exists("source", f.ref, who.sub) && !planted.has(f.ref)) return { status: 404, body: { error: "no such source" } };
      }
      if (!exists(body.item_kind, body.item_id, who.sub)) return { status: 404, body: { error: `no such ${body.item_kind}` } };
      const at = new Date(now()).toISOString();
      const r = { id: flagId(), owner_sub: who.sub, item_kind: body.item_kind, item_id: body.item_id, reason: body.reason, note: body.note ?? "", from_kind: f.kind, from_ref: f.ref, state: "open", created_at: at, updated_at: at };
      rows.push(r);
      return { status: 201, body: shape(r, false) };
    }
    if (!id && method === "GET") {
      const scope = u.searchParams.get("scope");
      if (scope !== null && scope !== "mine" && scope !== "all") return bad("scope is mine or all");
      if (scope === "all" && !admin) return { status: 403, body: { error: "scope=all is for admins" } };
      const state = u.searchParams.get("state"), kind = u.searchParams.get("item_kind");
      if (state && !STATES.includes(state)) return unreg("flag_states", state);
      if (kind && !ITEM_KINDS.includes(kind)) return unreg("flag_item_kinds", kind);
      const all = scope === "all";
      const mine = rows.filter((r) => (all || r.owner_sub === who.sub) && (!state || r.state === state) && (!kind || r.item_kind === kind));
      const lim = Math.max(1, Math.min(500, Number(u.searchParams.get("limit") || 100)));
      const sorted = [...mine].sort((a, b) => b.created_at.localeCompare(a.created_at) || (a.id < b.id ? -1 : 1));
      return { status: 200, body: { flags: sorted.slice(0, lim).map((r) => shape(r, all)), total: mine.length } };
    }
    if (id && method === "GET") {
      const r = UUIDISH.test(id) ? rows.find((x) => x.id === id && (admin || x.owner_sub === who.sub)) : null;
      return r ? { status: 200, body: shape(r, admin && r.owner_sub !== who.sub) } : NO_FLAG;
    }
    if (id && method === "PATCH") {
      if (!UUIDISH.test(id)) return NO_FLAG;
      if (Object.keys(body ?? {}).some((k) => !["reason", "note", "state"].includes(k))) return invalid("unrecognized key");
      if (body.reason === undefined && body.note === undefined && body.state === undefined) return bad("give reason, note or state");
      if (body.reason !== undefined && !REASONS.includes(body.reason)) return unreg("flag_reasons", body.reason);
      if (body.state !== undefined && !STATES.includes(body.state)) return unreg("flag_states", body.state);
      const r = rows.find((x) => x.id === id && x.owner_sub === who.sub);
      if (!r) return NO_FLAG;
      if (body.reason !== undefined) r.reason = body.reason;
      if (body.note !== undefined) r.note = body.note;
      if (body.state !== undefined) r.state = body.state;
      r.updated_at = new Date(now()).toISOString();
      return { status: 200, body: shape(r, false) };
    }
    return { status: 405, body: { error: "method not allowed" } };
  }
  return {
    handle,
    reset() { rows = []; seq = 0; },
    rows: () => rows,
    setAdmins(subs) { adminSubs = new Set(subs); },
    plantSource(id) { planted.add(id); },
    itemsSnapshot,
  };
}
