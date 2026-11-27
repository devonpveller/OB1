// A fake of the workbench routes the References tab uses (rwr-doc-refs), layered over docs-fake.mjs (the documents
// back end the other suites drive). The vitest suite (test/doc-refs.test.tsx) and the e2e stub (e2e/refs.stub.mjs) both
// drive THIS one, so the two cannot drift. It copies the real code as the app sees it:
//   - contracts/routes/pending_refs.ts + contracts/repo/pending_refs.ts (the "to place" queue): GET/POST
//     /workbench/contract/documents/pending-refs, DELETE .../{id}, POST .../{id}/place. Another user's document, an
//     unlisted one and a missing one are ALL 404 {"error":"no such document"}; another user's row, a missing row and a
//     malformed id are ALL 404 {"error":"no such pending reference"}; a duplicate is 409 naming the waiting row; the queue
//     holds 200 per document; placing deletes the row and pins a record in one step (a refusal leaves the row where it
//     was); a claim cite is placed on the source the claim states from (none: 422);
//   - routes/documents.ts: GET /documents/references (holder rows in seq order + `listed`), POST /documents/references
//     (chip | transclusion | added), DELETE /documents/references/:id (an ADDED one only; a cited one is 404 with the
//     "removed from the text" words), POST /documents/references/:id/repin (a NEW record at the current revision; the
//     quote must be found again, else 422), GET /documents/candidates;
//   - documents/listing.ts syncHolders: a save of the file drops the document's CITED holders that the text no longer names;
//   - contracts/routes/appendix.ts: POST /contract/diff-check (references[] form) and GET /contract/sources/{id}/quality;
//   - contracts/repo/references.ts referenceById for a plain SOURCE id (record null, source set).
// A planted marker: every title and text of alice's carries ALPHA, every one of bob's BRAVO.
import { createFake, PEOPLE } from "./docs-fake.mjs";

export { PEOPLE };
export const CPU = "documents/k-a/Hardware/cpu.md";
export const BRAVO = "documents/k-b/bravo.md";
const id = (n, tail) => `${n.padEnd(8, "0")}-0000-4000-8000-${String(tail).padStart(12, "0")}`;
// sources (shared knowledge, by id)
export const S_SOCKET = id("b1", "a1");   // revision 3 now; REF_SOCKET pins revision 2
export const S_POWER = id("b2", "a2");    // revision 1; the quote is still there
export const S_COOL = id("b3", "a3");     // attached (added), not in the text
export const S_NEW = id("b4", "a4");      // a candidate nobody cites
export const S_DRIFT = id("b5", "a5");    // revision 2 no longer holds the pinned words
export const S_BARE = id("b6", "a6");     // no quality rating
export const S_LONG = id("b7", "a7");     // a title with a long unbroken word (the 400 px checks)
export const S_BRAVO = id("b9", "b9");    // bob's held source: alice must never see it
export const C_POWER = id("c1", "a1");    // a claim that states from S_POWER
export const C_ORPHAN = id("c2", "a2");   // a claim that states from no source
// reference records
export const REF_SOCKET = id("a1", "01");
export const REF_POWER = id("a2", "02");
export const REF_COOL = id("a3", "03");
export const REF_DRIFT = id("a4", "04");
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHIP = /\[@ref:([0-9a-f-]{36})\]/gi;
const TRANS = /\{\{ref:([0-9a-f-]{36})\}\}([\s\S]*?)\{\{\/ref\}\}/gi;
const NO_DOC = { status: 404, body: { error: "no such document" } };
const NO_REF = { status: 404, body: { error: "no such pending reference" } };
const MAX_PER_DOCUMENT = 200;
const NOW = "2026-11-27T09:00:00.000Z";

const SOURCES = () => new Map([
  [S_SOCKET, { title: "ALPHA Socket guide", held: false, owner: null, quality: { value: 0.82, family: "scholarly", factors: [{ name: "corroboration", value: 0.5, reason: "two independent sources agree" }] },
    revs: [{ rev: 1, content: "Socket intro.\n\nThe LGA2066 socket takes a 140 W part." }, { rev: 2, content: "Socket intro.\n\nThe LGA2066 socket takes a 165 W part, per the vendor." },
      { rev: 3, content: "Socket intro, revised.\n\nPer the vendor, the LGA2066 socket takes a 165 W part. A new BIOS is needed." }] }],
  [S_POWER, { title: "ALPHA Power budget", held: false, owner: null, quality: { value: 0.4, family: "general", factors: [{ name: "single source", value: 0.4, reason: "nobody else reports this" }] },
    revs: [{ rev: 1, content: "Power overview.\n\nThe chip draws 140 W under load." }] }],
  [S_COOL, { title: "ALPHA Cooling paper", held: false, owner: null, quality: { value: 0.9, family: "scholarly", factors: [] },
    revs: [{ rev: 1, content: "Cooling.\n\nA 240 mm radiator keeps it under 80 C." }] }],
  [S_NEW, { title: "ALPHA Memory timings", held: false, owner: null, quality: { value: 0.7, family: "general", factors: [] },
    revs: [{ rev: 1, content: "Memory.\n\nQuad channel DDR4-3200 is supported." }] }],
  [S_DRIFT, { title: "ALPHA Drifting note", held: false, owner: null, quality: { value: 0.3, family: "general", factors: [] },
    revs: [{ rev: 1, content: "Drift.\n\nThe fan is rated for 4000 rpm." }, { rev: 2, content: "Drift.\n\nThe fan was replaced; the rating changed completely." }] }],
  [S_BARE, { title: "ALPHA Unrated memo", held: false, owner: null, quality: null,
    revs: [{ rev: 1, content: "Memo.\n\nThis has no rating yet." }] }],
  [S_LONG, { title: "ALPHA " + "Unbroken".repeat(12) + " paper", held: false, owner: null, quality: { value: 0.6, family: "general", factors: [] },
    revs: [{ rev: 1, content: "Long.\n\nA source whose title has no break points." }] }],
  [S_BRAVO, { title: "BRAVO private held source", held: true, owner: "u-bob", quality: { value: 0.5, family: "general", factors: [] },
    revs: [{ rev: 1, content: "BRAVO secret held words." }] }],
]);
const CLAIMS = () => new Map([
  [C_POWER, { text: "ALPHA the chip draws 140 W", source_id: S_POWER }],
  [C_ORPHAN, { text: "ALPHA a claim with no source", source_id: null }],
]);

const head = (s) => s.revs[s.revs.length - 1];
const chunksOf = (content) => content.split("\n\n");
// the source as the caller may read it: another user's held source is a missing one (anyTarget)
const readable = (state, sid, who) => { const s = state.sources.get(String(sid ?? "").toLowerCase()); return s && (!s.held || s.owner === who.sub) ? s : null; };
const quoteIn = (s, rev, exact) => (s.revs.find((r) => r.rev === rev) ?? head(s)).content.includes(exact);

export function createRefsFake(opts = {}) {
  const base = createFake(opts);
  let state;
  let seq = 0;
  const plant = () => {
    state = { sources: SOURCES(), claims: CLAIMS(), records: new Map(), holders: new Map(), pending: new Map(), seq: 0 };
    seq = 0;
    const put = (path, rid, sid, pinned, exact, origin, chunk) => {
      state.records.set(rid, { id: rid, source_id: sid, scope: "span", provenance: "user", pinned_revision: pinned, chunk_idx: chunk, state: "pinned",
        selectors: { quote: { exact }, position: { start: 0, end: exact.length } }, created_by: "Alice Lab", created_at: NOW });
      const list = state.holders.get(path) ?? [];
      list.push({ origin, seq: list.length, reference_id: rid });
      state.holders.set(path, list);
    };
    const d = base.db().docs.get(CPU);
    d.body = `# CPU plan\n\n## Socket\nThe board fits it. [@ref:${REF_SOCKET}]\n\n## Power\n{{ref:${REF_POWER}}}The chip draws 140 W under load.{{/ref}}\n\n## Drift\n{{ref:${REF_DRIFT}}}The fan is rated for 4000 rpm.{{/ref}}\n`;
    delete d.raw;
    put(CPU, REF_SOCKET, S_SOCKET, 2, "takes a 165 W part", "cited", 1);
    put(CPU, REF_POWER, S_POWER, 1, "The chip draws 140 W under load.", "cited", 1);
    put(CPU, REF_DRIFT, S_DRIFT, 1, "The fan is rated for 4000 rpm.", "cited", 1);
    put(CPU, REF_COOL, S_COOL, 1, "A 240 mm radiator keeps it under 80 C.", "added", 1);
    const row = (owner, path, source_id, claim_id, section, quote, from, n) => {
      const rid = id("9e", 100 + n);
      state.pending.set(rid, { id: rid, owner, path, source_id, claim_id, section, quote, added_from: from, created_at: new Date(Date.parse(NOW) + n * 1000).toISOString() });
    };
    row("u-alice", CPU, S_NEW, null, "Memory", "", "source", 1);
    row("u-alice", CPU, null, C_POWER, "", "", "chat", 2);
    row("u-bob", BRAVO, S_BRAVO, null, "BRAVO section", "BRAVO secret held words.", "source", 3);
  };
  plant();
  const reset = () => { base.reset(); plant(); };

  const rootOf = (who) => `documents/${who.key}`;
  const relOf = (p, who) => (String(p ?? "").startsWith("documents/") ? String(p) : `${rootOf(who)}/${p}`);
  const listed = (path, who) => { const d = base.db().docs.get(path); return d && d.owner === who.sub ? d : null; };
  const textOf = (path) => { const d = base.db().docs.get(path); return d ? (d.raw ?? `---\ntitle: ${JSON.stringify(d.title)}\n---\n${d.body}`) : ""; };
  const recView = (r) => ({ ...r });
  const holdersOf = (path) => state.holders.get(path) ?? [];

  // routes/documents.ts holder row (one per reference record, in seq order)
  const rowOf = (h) => {
    const r = state.records.get(h.reference_id), s = state.sources.get(r.source_id);
    const rv = s.revs.find((x) => x.rev === r.pinned_revision);
    return { origin: h.origin, seq: h.seq, reference_id: r.id, source_id: r.source_id, pinned_revision: r.pinned_revision, scope: r.scope, title: s.title ?? rv?.title ?? "" };
  };
  const placeRecord = (state0, who, path, sid, exact, origin) => {
    const s = readable(state0, sid, who);
    if (!s) return { status: 404, body: { error: "no source or held source with this id" } };
    let chunk = null, scope = "span";
    const cur = head(s);
    if (exact && exact.trim()) {
      if (!cur.content.includes(exact)) return { status: 422, body: { error: `the quote is not in revision ${cur.rev} of ${sid}` } };
      chunk = chunksOf(cur.content).findIndex((c) => c.includes(exact));
    } else { scope = "source"; exact = cur.content.slice(0, 200); chunk = 0; }
    const rid = id("a9", ++seq + 100);
    const rec = { id: rid, source_id: sid, scope, provenance: "user", pinned_revision: cur.rev, chunk_idx: chunk, state: "pinned",
      selectors: { quote: { exact }, position: { start: cur.content.indexOf(exact), end: cur.content.indexOf(exact) + exact.length } }, created_by: who.name, created_at: new Date().toISOString() };
    state.records.set(rid, rec);
    const list = state.holders.get(path) ?? [];
    list.push({ origin, seq: list.length ? Math.max(...list.map((x) => x.seq)) + 1 : 0, reference_id: rid });
    state.holders.set(path, list);
    return { rec };
  };
  const insertFor = (form, rec) => form === "transclusion" ? `{{ref:${rec.id}}}${rec.selectors.quote.exact.replace(/\{\{\/ref\}\}/g, "{{ /ref}}")}{{/ref}}` : form === "chip" ? `[@ref:${rec.id}]` : null;
  const drop = (path, h) => {
    state.holders.set(path, holdersOf(path).filter((x) => x !== h));
    if (![...state.holders.values()].some((l) => l.some((x) => x.reference_id === h.reference_id))) state.records.delete(h.reference_id);
  };
  // listing.ts syncHolders: after a save the cited holders the text no longer names are dropped
  const sync = (path) => {
    const text = textOf(path);
    const named = new Set([...text.matchAll(CHIP)].map((m) => m[1].toLowerCase()));
    for (const m of text.matchAll(TRANS)) named.add(m[1].toLowerCase());
    for (const h of [...holdersOf(path)]) if (h.origin === "cited" && !named.has(h.reference_id)) drop(path, h);
  };

  function handle(person, method, url, body = {}) {
    const who = PEOPLE[person];
    const u = new URL(url, "http://x");
    const p = u.pathname;
    if (!who) return base.handle(person, method, url, body);
    const q = (k) => u.searchParams.get(k) ?? "";
    // ── the queue ──
    const PR = "/workbench/contract/documents/pending-refs";
    if (p === PR || p.startsWith(PR + "/")) return queue(who, method, p.slice(PR.length), u, body);
    // ── documents routes ──
    if (p === "/workbench/documents/references" && method === "GET") {
      const path = relOf(q("path"), who);
      if (!listed(path, who)) return NO_DOC;
      const rows = holdersOf(path).map(rowOf);
      const seen = new Set(), out = [];
      for (const r of rows) if (!seen.has(r.source_id)) { seen.add(r.source_id); out.push({ number: out.length + 1, source_id: r.source_id, title: r.title, reference_ids: rows.filter((x) => x.source_id === r.source_id).map((x) => x.reference_id) }); }
      return { status: 200, body: { path, style: "ieee", references: rows, listed: out } };
    }
    if (p === "/workbench/documents/references" && method === "POST") {
      const path = relOf(body.path, who);
      if (!listed(path, who)) return NO_DOC;
      const form = String(body.form ?? "") || "chip";
      if (!["chip", "transclusion", "added"].includes(form)) return { status: 400, body: { error: "form is chip, transclusion or added" } };
      const r = placeRecord(state, who, path, String(body.source_id ?? ""), body.exact ? String(body.exact) : null, form === "added" ? "added" : "cited");
      if (!r.rec) return r;
      return { status: 201, body: { record: recView(r.rec), form, insert: insertFor(form, r.rec) } };
    }
    let m = /^\/workbench\/documents\/references\/([^/]+)(\/repin)?$/.exec(p);
    if (m && method === "DELETE" && !m[2]) {
      const path = relOf(q("path"), who);
      if (!listed(path, who)) return NO_DOC;
      const rid = decodeURIComponent(m[1]);
      const h = holdersOf(path).find((x) => x.reference_id === rid && x.origin === "added");
      if (!h) return { status: 404, body: { error: "no added reference with this id on this document (a cited one is removed from the text)" } };
      drop(path, h);
      return { status: 200, body: { removed: rid } };
    }
    if (m && method === "POST" && m[2]) {
      const path = relOf(q("path"), who);
      if (!listed(path, who)) return NO_DOC;
      const rid = decodeURIComponent(m[1]);
      const rec = state.records.get(rid);
      // getRecordFor: a record held only by another user's document or pointing at another user's held source is a missing one
      const mineOrShared = rec && (!state.sources.get(rec.source_id).held || state.sources.get(rec.source_id).owner === who.sub);
      if (!mineOrShared) return { status: 404, body: { error: "no reference record with this id" } };
      const r = placeRecord(state, who, path, rec.source_id, rec.selectors.quote.exact, "cited");
      if (!r.rec) return r;
      return { status: 201, body: { replaces: rid, record: recView(r.rec), insert: insertFor("transclusion", r.rec) } };
    }
    if (p === "/workbench/documents/candidates" && method === "GET") {
      const path = q("path") ? relOf(q("path"), who) : null;
      if (path && !listed(path, who)) return NO_DOC;
      const query = q("q").trim();
      const out = [];
      if (query.length >= 2) {
        for (const [sid, s] of state.sources) {
          if (s.held && s.owner !== who.sub) continue;
          if (s.title.toLowerCase().includes(query.toLowerCase()) || head(s).content.toLowerCase().includes(query.toLowerCase())) {
            out.push({ kind: "source", id: sid, title: s.title, snippet: head(s).content.slice(0, 80), state: "active", lifecycle: "active", insert: `[[source:${sid}|${s.title}]]`, tags: s.hidden ? ["hidden in this session"] : [] });
          }
        }
        for (const [cid, c] of state.claims) if (c.text.toLowerCase().includes(query.toLowerCase())) out.push({ kind: "claim", id: cid, title: c.text, snippet: "", state: "active", lifecycle: null, insert: `[[claim:${cid}|${c.text}]]`, tags: [] });
        // a user's OTHER documents are candidates too (candidates.ts): the tab must not offer them as sources
        for (const [dp, d] of base.db().docs) if (d.owner === who.sub && dp !== path && d.title.toLowerCase().includes(query.toLowerCase())) out.push({ kind: "document", id: dp, title: d.title, snippet: dp, state: "current", insert: `[[doc:${dp}|${d.title}]]`, tags: [] });
      }
      return { status: 200, body: { query, refinery_id: null, candidates: out } };
    }
    // ── contract reads ──
    if (p === "/workbench/contract/diff-check" && method === "POST") {
      const refs = Array.isArray(body.references) ? body.references : [];
      if (!refs.length) return { status: 400, body: { error: "give references or holder" } };
      const missing = refs.map((r) => r.reference_id).filter((rid) => { const rec = state.records.get(rid); return !rec || (state.sources.get(rec.source_id).held && state.sources.get(rec.source_id).owner !== who.sub); });
      if (missing.length) return { status: 404, body: { error: `no reference record with id ${missing.join(", ")}` } };
      return { status: 200, body: { results: refs.map((r) => {
        const rec = state.records.get(r.reference_id), s = state.sources.get(rec.source_id), cur = head(s);
        const out = cur.rev > rec.pinned_revision;
        let eq = null, anchor = "none";
        if (!out) { eq = rec.chunk_idx !== null ? `${rec.source_id}:${rec.chunk_idx}` : null; anchor = rec.chunk_idx !== null ? "pinned" : "none"; }
        else if (rec.scope === "source") { eq = `${rec.source_id}:0`; anchor = "first_chunk"; }
        else { const i = chunksOf(cur.content).findIndex((c) => c.includes(rec.selectors.quote.exact)); if (i >= 0) { eq = `${rec.source_id}:${i}`; anchor = "requoted"; } else anchor = "lost"; }
        return { reference_id: rec.id, source_id: rec.source_id, pinned_revision: rec.pinned_revision, current_revision: cur.rev, out_of_date: out, chunk_idx: rec.chunk_idx,
          equivalent_current_chunk_id: eq, anchor, state: out ? "updated" : "current", lifecycle: s.held ? "held" : "active" };
      }) } };
    }
    m = /^\/workbench\/contract\/sources\/([^/]+)\/quality$/.exec(p);
    if (m && method === "GET") {
      const s = readable(state, decodeURIComponent(m[1]), who);
      if (!s) return { status: 404, body: { error: "no source with this id" } };
      const k = s.quality;
      return { status: 200, body: { source_id: decodeURIComponent(m[1]), state: "active", state_detail: {}, lifecycle: s.held ? "held" : "active", family: k?.family ?? "general",
        score: { value: k ? k.value : null, refinery_scoped: null, version: "d15-1", computed_from: "rolling total" }, claim_kind: null, signals: {}, corroborated_by: [], contradicted_by: [], history: [], factors: k?.factors ?? [] } };
    }
    m = /^\/workbench\/contract\/references\/([^/]+)$/.exec(p);
    if (m && method === "GET") {
      const rid = decodeURIComponent(m[1]).toLowerCase();
      const rec = state.records.get(rid);
      const srcId = rec ? rec.source_id : rid;
      const s = readable(state, srcId, who);
      if (s) {
        const pinned = rec ? rec.pinned_revision : head(s).rev;
        return { status: 200, body: { id: rid, kind: rec ? "reference" : "source", requested_version: pinned, state: head(s).rev > pinned ? "updated" : "active", state_detail: {}, lifecycle: s.held ? "held" : "active",
          version: head(s).rev, tombstone: null, record: rec ? recView(rec) : null,
          source: s.held ? null : { title: s.title, url: null, content_type: "text/plain", domain: null, family: "general", excerpt: head(s).content.slice(0, 80), created_at: NOW, updated_at: NOW },
          held: s.held ? { refinery_id: "r-1", title: s.title, url: null, excerpt: head(s).content.slice(0, 80), user_source_status: "ready" } : null } };
      }
      if (rec || state.sources.has(rid)) return { status: 404, body: { error: "no reference record, source, held source or tombstone with this id" } };
    }
    m = /^\/workbench\/contract\/chunks\/([0-9a-f-]{36}):(\d{1,6})\/context$/i.exec(decodeURIComponent(p));
    if (m && method === "GET") {
      const s = readable(state, m[1], who);
      const cs = s ? chunksOf(head(s).content) : [];
      const idx = Number(m[2]), win = Math.min(10, Number(q("window") || 1));
      if (!s || !cs[idx]) return { status: 404, body: { error: "no such chunk" } };
      return { status: 200, body: { chunk_id: `${m[1]}:${idx}`, source_id: m[1], idx, window: win, state: "active", lifecycle: "active", state_detail: {},
        chunks: cs.map((content, i) => ({ idx: i, content })).filter((c) => Math.abs(c.idx - idx) <= win).map((c) => ({ ...c, is_target: c.idx === idx })) } };
    }
    // everything else (the file route included) is the documents fake's; a saved file syncs the holders
    const r = base.handle(person, method, url, body);
    if (r && method === "PUT" && p === "/workbench/documents/file" && r.status === 200) sync(relOf(q("path"), who));
    return r;
  }

  function queue(who, method, rest, u, body) {
    const q = (k) => u.searchParams.get(k) ?? "";
    const mine = () => [...state.pending.values()].filter((r) => r.owner === who.sub);
    const out = (r) => ({ id: r.id, path: r.path, source_id: r.source_id, claim_id: r.claim_id, section: r.section, quote: r.quote, added_from: r.added_from, created_at: r.created_at });
    if (rest === "" && method === "GET") {
      if (!q("path")) return { status: 400, body: { error: "path (the document's vault path) is required" } };
      const path = relOf(q("path"), who);
      if (!listed(path, who)) return NO_DOC;
      const rows = mine().filter((r) => r.path === path).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      return { status: 200, body: { path, pending_refs: rows.slice(0, Math.min(200, Number(q("limit") || 100))).map(out), total: rows.length } };
    }
    if (rest === "" && method === "POST") {
      const known = ["path", "source_id", "claim_id", "section", "quote", "added_from"];
      if (Object.keys(body).some((k) => !known.includes(k))) return { status: 400, body: { error: "invalid request: unrecognized key" } };
      if (typeof body.path !== "string" || !/^[a-z][a-z0-9_.:-]{0,63}$/.test(String(body.added_from ?? ""))) return { status: 400, body: { error: "invalid request" } };
      if ((body.source_id === undefined) === (body.claim_id === undefined)) return { status: 400, body: { error: "give exactly one of source_id or claim_id" } };
      const path = relOf(body.path, who);
      if (!listed(path, who)) return NO_DOC;
      if (body.source_id !== undefined && !readable(state, body.source_id, who)) return { status: 404, body: { error: "no such source" } };
      if (body.claim_id !== undefined && !state.claims.has(body.claim_id)) return { status: 404, body: { error: "no such claim" } };
      const mineHere = mine().filter((r) => r.path === path);
      if (mineHere.length >= MAX_PER_DOCUMENT) return { status: 409, body: { error: `this document's to-place queue is full (${MAX_PER_DOCUMENT} cites): place or remove some first` } };
      const key = (r) => `${r.source_id ?? "claim:" + r.claim_id}|${r.quote}`;
      const row = { id: id("9e", 1000 + ++state.seq), owner: who.sub, path, source_id: body.source_id ?? null, claim_id: body.claim_id ?? null, section: body.section ?? "", quote: body.quote ?? "",
        added_from: body.added_from, created_at: new Date().toISOString() };
      const dup = mineHere.find((r) => key(r) === key(row));
      if (dup) return { status: 409, body: { error: "this cite is already waiting in this document", detail: { pending_ref_id: dup.id } } };
      state.pending.set(row.id, row);
      return { status: 201, body: out(row) };
    }
    const m = /^\/([^/]+?)(\/place)?$/.exec(rest);
    if (m && method === "DELETE" && !m[2]) {
      const row = UUIDISH.test(m[1]) ? state.pending.get(m[1].toLowerCase()) : null;
      if (!row || row.owner !== who.sub) return NO_REF;
      state.pending.delete(row.id);
      return { status: 200, body: { removed: row.id } };
    }
    if (m && method === "POST" && m[2]) {
      const form = body.form ?? "chip";
      if (!["chip", "transclusion"].includes(form)) return { status: 400, body: { error: "form is chip or transclusion" } };
      const row = UUIDISH.test(m[1]) ? state.pending.get(m[1].toLowerCase()) : null;
      if (!row || row.owner !== who.sub) return NO_REF;
      if (form === "transclusion" && !row.quote.trim()) return { status: 400, body: { error: "a transclusion needs a quote: this cite has none" } };
      const sid = row.source_id ?? state.claims.get(row.claim_id)?.source_id ?? null;
      if (!sid) return { status: 422, body: { error: "the claim states from no source to place a reference on" } };
      const r = placeRecord(state, who, row.path, sid, row.quote.trim() ? row.quote : null, "cited");
      if (!r.rec) return r.status === 422 ? { status: 422, body: { ...r.body, detail: { rule: "reference" } } } : r; // refused: the row stays where it was
      state.pending.delete(row.id);
      return { status: 201, body: { pending_ref_id: row.id, form, record: recView(r.rec), insert: insertFor(form, r.rec) } };
    }
    return { status: 404, body: { error: "not found" } };
  }

  // the planted source's text can move on (a new revision), as a research run would do
  const addRevision = (sid, content) => { const s = state.sources.get(sid); s.revs.push({ rev: head(s).rev + 1, content }); };
  return { handle, reset, db: () => ({ ...base.db(), refs: state }), base, addRevision, state: () => state };
}
