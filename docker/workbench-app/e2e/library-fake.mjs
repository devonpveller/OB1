// A fake of the workbench's back end for the Library shell (rwr-lib-shell): the vitest suite (test/library.test.tsx) and the
// e2e stub (e2e/library.stub.mjs) both drive THIS one, so the two cannot drift. It copies the real routes' behaviour as the
// app sees it:
//   - the account's UI state keys: GET /settings, PUT /settings/<key> (versioned), DELETE /settings/<key>?version= (versioned,
//     a delete is a version, a key's number never goes back): settings/routes.ts, init-ui-state.sql setting_problem /
//     user_setting_set / user_setting_clear. library.recent is a ref_list: at most 24 items, each {kind, id[, locked]} and no
//     other key, kind one of source/claim/topic/gap/document/idea/run, an id an opaque identifier (a document id a documents/
//     path), at most 120 characters, no credential-shaped text, the whole value at most 4096 characters. A stale version is 409.
//   - POST /contract/source-states {ids, urls}: contracts/repo/knowledge.ts sourceStates - a sources row (its lifecycle) or a
//     tombstone ("erased"); a HELD source, an unknown id and anything else is ABSENT from by_id, never a hint; ids are
//     lower-cased and de-duplicated; at most 200.
//   - GET /contract/search?q=&limit=: contracts/repo/knowledge.ts search. The shared search does NOT filter a claim drawn from
//     a user's private idea report (research_private_report_claims): the planted private-report claim IS returned to anyone who
//     searches its words - the real route does exactly that today (recorded in the findings of rwr-lib-shell), so the fake does.
//   - the document's "to place" queue: GET/POST /contract/documents/pending-refs and DELETE .../<id>: contracts/routes/
//     pending_refs.ts, repo/pending_refs.ts, schemas/pending_refs.ts. The body is strict (an unknown field is 400), exactly one
//     of source_id / claim_id (400), the document must be the caller's own LISTED document (404 "no such document", the same
//     answer for another user's), a source must exist in the shared library or be the caller's held source (404 "no such
//     source": a suppressed or cut-loose source is still a source; an erased one is not), a claim must exist (404 "no such
//     claim": ANY claim, a private-report claim included - the real route has no private-report check), the same cite and
//     quote twice is 409 with the row already waiting, a queue holds at most 200 cites (409), another user's row is 404 "no
//     such pending reference".
// Identity comes from the `person` the caller passes (the stub's mode), never from a body. The fake is not the server: the
// server's own isolation is its lab's (the contract tests).
import { PEOPLE } from "./docs-fake.mjs";

export const KINDS = ["source", "claim", "topic", "gap", "document", "idea", "run"];
export const UI_KEYS = ["ui.locked_document", "ui.last_document", "ui.start_screen", "library.recent"];
export const START_SCREENS = ["home", "research", "chat", "documents", "ideas", "podcasts", "library"];
export const MAX_PER_DOCUMENT = 200;

const hex = (n) => n.toString(16).padStart(2, "0");
// twelve shared, active sources; the marker SRC-SHARED is in every title so a leak is a string match
export const SRC = (n) => `b3000000-0000-4000-8000-0000000000${hex(n)}`;
export const SRC_HIDDEN = "b3000000-0000-4000-8000-0000000000a1"; // suppressed
export const SRC_CUT = "b3000000-0000-4000-8000-0000000000a2"; // unlinked
export const SRC_GONE = "b3000000-0000-4000-8000-0000000000a3"; // erased: only its tombstone is left
export const SRC_HELD_A = "b3000000-0000-4000-8000-0000000000b1"; // alice's held source (a refinery's): not library material
export const CLAIM_SHARED = "c3000000-0000-4000-8000-000000000001";
export const CLAIM_PRIVATE_A = "c3000000-0000-4000-8000-0000000000f1"; // drawn from alice's PRIVATE idea report
export const PRIVATE_MARKER = "CLAIM-PRIVATE-ALICE-REPORT";

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CTRL_ID = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const CREDENTIAL = /(^|[^A-Za-z0-9])(sk-|sk_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza|ya29\.|eyJ)|(^|[^a-z0-9])bearer\s/i;
const CLEAN = (s) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s);
const ADDED_FROM = /^[a-z][a-z0-9_.:-]{0,63}$/;
const iso = (ms) => new Date(ms).toISOString();

// the text of a jsonb, as the database counts it (members joined by ", ", key and value by ": ")
function jsonbText(v) {
  if (Array.isArray(v)) return "[" + v.map(jsonbText).join(", ") + "]";
  if (v && typeof v === "object") {
    const keys = Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return "{" + keys.map((k) => JSON.stringify(k) + ": " + jsonbText(v[k])).join(", ") + "}";
  }
  return JSON.stringify(v);
}

// init-ui-state.sql setting_problem, for the four keys: null = fine, else the refusal's words
export function settingProblem(key, value) {
  if (!UI_KEYS.includes(key)) return `${key} is not a setting`;
  if (value === null || value === undefined) return "a value is required (delete the setting to go back to the default)";
  if (jsonbText(value).length > 4096) return "the value is too large";
  if (key === "ui.start_screen") return typeof value === "string" && START_SCREENS.includes(value) ? null : `must be one of ${JSON.stringify(START_SCREENS)}`;
  if (key === "ui.locked_document" || key === "ui.last_document") {
    if (typeof value !== "string") return "must be text";
    const s = value;
    if (s.trim() === "") return "must not be empty (delete the setting to go back to the default)";
    if (s.length > 400) return "must be at most 400 characters";
    if (/[\u0000-\u001f\u007f]/.test(s)) return "must not hold control characters";
    if (CREDENTIAL.test(s)) return "this looks like a credential; secrets are not stored in settings";
    if (!/^documents\/./.test(s)) return "a document path starts with documents/";
    if (CTRL_ID.test(s) || s.includes("\\")) return "a document path has no control, invisible or direction characters";
    if (/(^|\/)\.\.?(\/|$)/.test(s)) return "a document path has no dot segments";
    return null;
  }
  // library.recent: ref_list
  if (!Array.isArray(value)) return "must be a list";
  if (value.length > 24) return "the list is too long";
  const bad = value.some((e) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) return true;
    if (Object.keys(e).some((k) => !["kind", "id", "locked"].includes(k))) return true;
    if (typeof e.kind !== "string" || typeof e.id !== "string") return true;
    if ("locked" in e && typeof e.locked !== "boolean") return true;
    if (!KINDS.includes(e.kind)) return true;
    if (e.id.trim() === "" || e.id.length > 120) return true;
    if (CTRL_ID.test(e.id) || e.id.includes("\\") || /(^|\/)\.\.?(\/|$)/.test(e.id) || e.id.includes("..")) return true;
    if (CREDENTIAL.test(e.id)) return true;
    return e.kind === "document" ? !/^documents\/./.test(e.id) : !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(e.id);
  });
  return bad ? 'every item must be {"kind": one of the allowed kinds, "id": an identifier[, "locked": true or false]}' : null;
}

export function createLibraryFake({ docs, now = () => Date.now() }) {
  let sources, claims, held, tombstones, privateClaims, accounts, pending, seq;
  const reset = () => {
    const t = now();
    sources = new Map();
    for (let n = 1; n <= 12; n++) sources.set(SRC(n), { id: SRC(n), title: `SRC-SHARED Source ${n}`, lifecycle: "active", url: `https://example.org/s${n}`, created: iso(t - n * 3600e3) });
    sources.set(SRC_HIDDEN, { id: SRC_HIDDEN, title: "SRC-SHARED Hidden source", lifecycle: "suppressed", url: "https://example.org/hidden", created: iso(t - 30 * 3600e3) });
    sources.set(SRC_CUT, { id: SRC_CUT, title: "SRC-SHARED Cut loose source", lifecycle: "unlinked", url: "https://example.org/cut", created: iso(t - 31 * 3600e3) });
    tombstones = new Map([[SRC_GONE, { id: "d3000000-0000-4000-8000-000000000001", url: "https://example.org/gone" }]]);
    held = new Map([[SRC_HELD_A, { id: SRC_HELD_A, owner: PEOPLE.alice.sub, title: "SRC-HELD-ALICE refinery notes" }]]);
    claims = new Map([
      [CLAIM_SHARED, { id: CLAIM_SHARED, text: "CLAIM-SHARED the socket takes 165 W", created: iso(t - 5 * 3600e3) }],
      [CLAIM_PRIVATE_A, { id: CLAIM_PRIVATE_A, text: `${PRIVATE_MARKER} the owner's own finding`, created: iso(t - 4 * 3600e3) }],
    ]);
    privateClaims = new Map([[CLAIM_PRIVATE_A, PEOPLE.alice.sub]]); // research_private_report_claims: claim -> report owner
    accounts = { alice: new Map(), bob: new Map() }; // key -> { value, version } (live) ; tombstone versions below
    accounts.tomb = { alice: new Map(), bob: new Map() };
    pending = [];
    seq = 0;
  };
  reset();

  const cur = (person, key) => accounts[person].get(key)?.version ?? accounts.tomb[person].get(key) ?? 0;
  const err = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

  const ownsDocument = (who, path) => docs.db().docs.get(path)?.owner === who.sub;

  function settings(person, who, method, p, u, body) {
    if (p === "/workbench/settings" && method === "GET") {
      return { status: 200, body: { admin: false, settings: UI_KEYS.map((k) => ({ key: k, value: accounts[person].get(k)?.value ?? null, version: cur(person, k) })) } };
    }
    const m = /^\/workbench\/settings\/(.+)$/.exec(p);
    if (!m) return null;
    const key = decodeURIComponent(m[1]);
    if (!UI_KEYS.includes(key)) return err(404, `${key} is not a setting`);
    if (method === "PUT") {
      if (!body || typeof body !== "object" || !("value" in body)) return err(400, "a JSON body {value, version?} is required");
      if (body.version !== undefined && (!Number.isInteger(body.version) || body.version < 0)) return err(400, "version must be a whole number");
      const why = settingProblem(key, body.value);
      if (why) return err(400, why);
      // the owner scope: a document path that is another user's answers like a missing one
      if ((key === "ui.locked_document" || key === "ui.last_document") && docs.db().docs.has(body.value) && !ownsDocument(who, body.value)) return err(404, "no such document");
      const c = cur(person, key);
      if (body.version !== undefined && body.version !== c) return err(409, `the setting changed since it was read (version ${c}, not ${body.version})`);
      accounts[person].set(key, { value: body.value, version: c + 1 });
      accounts.tomb[person].delete(key);
      return { status: 200, body: { key, value: body.value, version: c + 1 } };
    }
    if (method === "DELETE") {
      const v = u.searchParams.get("version");
      if (v !== null && !/^\d{1,9}$/.test(v)) return err(400, "version must be a whole number");
      const c = cur(person, key);
      if (v !== null && Number(v) !== c) return err(409, `the setting changed since it was read (version ${c}, not ${v})`);
      if (!accounts[person].has(key)) return { status: 200, body: { key, value: null, version: c } };
      accounts[person].delete(key);
      accounts.tomb[person].set(key, c + 1);
      return { status: 200, body: { key, value: null, version: c + 1 } };
    }
    return null;
  }

  function sourceStates(body) {
    if (!body || typeof body !== "object") return err(400, "invalid request");
    if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.length > 200)) return err(400, "invalid request", { detail: { issues: ["ids: at most 200"] } });
    if (body.urls !== undefined && (!Array.isArray(body.urls) || body.urls.length > 200)) return err(400, "invalid request");
    const ids = [...new Set((body.ids ?? []).filter((x) => typeof x === "string" && UUIDISH.test(x)).map((x) => x.toLowerCase()))].slice(0, 200);
    const by_id = {};
    for (const id of ids) {
      const s = sources.get(id);
      if (s) by_id[id] = { id, url: s.url, lifecycle: s.lifecycle, tombstone_id: null };
      else if (tombstones.has(id)) by_id[id] = { id, url: tombstones.get(id).url, lifecycle: "erased", tombstone_id: tombstones.get(id).id };
      // a held source, an unknown id: absent - never a hint
    }
    return { status: 200, body: { by_id, by_url: {} } };
  }

  function search(u) {
    const q = (u.searchParams.get("q") ?? "").trim();
    if (q.length < 2) return err(400, "invalid request");
    const limit = Math.min(50, Math.max(1, Number(u.searchParams.get("limit") || 25) || 25));
    const hit = (kind, id, title, text, extra) => ({
      kind, id, title: title.slice(0, 120), snippet: text.slice(0, 300), state: "current", lifecycle: null, page_class: null,
      topics: [], date: null, quality: null, cited_by: null, author: null, ...extra,
    });
    const has = (t) => t.toLowerCase().includes(q.toLowerCase());
    const results = [];
    for (const s of sources.values()) if (has(s.title)) results.push(hit("source", s.id, s.title, s.title, { lifecycle: s.lifecycle, date: s.created }));
    for (const c of claims.values()) if (has(c.text)) results.push(hit("claim", c.id, c.text, c.text, { date: c.created }));
    return { status: 200, body: { query: q, kinds: ["page", "claim", "source"], scope: { refinery_id: null }, count: Math.min(results.length, limit), results: results.slice(0, limit) }, headers: { "cache-control": "no-store, private" } };
  }

  function listedDoc(who, path) {
    if (typeof path !== "string" || path === "" || /[\u0000-\u001f]/.test(path)) return { err: err(400, "path must be a document path (a .md file under documents/)") };
    const segs = path.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
    const out = [];
    for (const s of segs) { if (s === "..") out.pop(); else out.push(s); }
    let rel = out.join("/");
    if (!rel.endsWith(".md")) return { err: err(400, "path must be a document path (a .md file under documents/)") };
    if (!rel.startsWith("documents/")) rel = `documents/${who.key}/${rel}`;
    const d = docs.db().docs.get(rel);
    if (!d || d.owner !== who.sub) return { err: err(404, "no such document") }; // another user's, an unlisted and a missing one: the one answer
    return { rel };
  }

  function pendingRefs(who, method, p, u, body) {
    const base = "/workbench/contract/documents/pending-refs";
    if (p !== base && !p.startsWith(base + "/")) return null;
    const rowOut = (r) => ({ id: r.id, path: r.path, source_id: r.source_id, claim_id: r.claim_id, section: r.section, quote: r.quote, added_from: r.added_from, created_at: r.created_at });
    if (p === base && method === "GET") {
      const path = u.searchParams.get("path");
      if (!path) return err(400, "path (the document's vault path) is required");
      const d = listedDoc(who, path);
      if (d.err) return d.err;
      const lim = Math.min(200, Math.max(1, Number(u.searchParams.get("limit") || 100) || 100));
      const mine = pending.filter((r) => r.owner === who.sub && r.path === d.rel);
      return { status: 200, body: { path: d.rel, pending_refs: mine.slice(0, lim).map(rowOut), total: mine.length } };
    }
    if (p === base && method === "POST") {
      if (!body || typeof body !== "object" || Array.isArray(body)) return err(400, "invalid request: the body must be a JSON object");
      const allowed = ["path", "source_id", "claim_id", "section", "quote", "added_from"];
      const issues = [];
      if (Object.keys(body).some((k) => !allowed.includes(k))) issues.push("unrecognized key");
      if (typeof body.path !== "string" || body.path.length < 1 || body.path.length > 1024 || !CLEAN(body.path)) issues.push("path");
      for (const k of ["source_id", "claim_id"]) if (k in body && !(typeof body[k] === "string" && UUIDISH.test(body[k]))) issues.push(k);
      if ("section" in body && !(typeof body.section === "string" && Array.from(body.section).length <= 200 && CLEAN(body.section))) issues.push("section");
      if ("quote" in body && !(typeof body.quote === "string" && Array.from(body.quote).length <= 4000 && CLEAN(body.quote))) issues.push("quote");
      if (!(typeof body.added_from === "string" && ADDED_FROM.test(body.added_from))) issues.push("added_from");
      if (issues.length) return err(400, "invalid request", { detail: { issues } });
      if ((body.source_id === undefined) === (body.claim_id === undefined)) return err(400, "give exactly one of source_id or claim_id");
      const d = listedDoc(who, body.path);
      if (d.err) return d.err;
      if (body.source_id !== undefined) {
        const id = body.source_id.toLowerCase();
        const h = held.get(id);
        if (!sources.has(id) && !(h && h.owner === who.sub)) return err(404, "no such source"); // erased, unknown, or another user's held
      } else if (!claims.has(body.claim_id)) {
        return err(404, "no such claim"); // ANY claim exists for this check, a private-report claim included
      }
      const mine = pending.filter((r) => r.owner === who.sub && r.path === d.rel);
      const key = (r) => (r.source_id ?? "claim:" + r.claim_id) + "|" + r.quote;
      const want = { source_id: body.source_id ?? null, claim_id: body.claim_id ?? null, quote: body.quote ?? "" };
      const dup = mine.find((r) => key(r) === key(want));
      if (dup) return err(409, "this cite is already waiting in this document", { detail: { pending_ref_id: dup.id } });
      if (mine.length >= MAX_PER_DOCUMENT) return err(409, `this document's to-place queue is full (${MAX_PER_DOCUMENT} cites): place or remove some first`);
      const row = { id: `9e1d0000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, owner: who.sub, path: d.rel, source_id: want.source_id, claim_id: want.claim_id,
        section: body.section ?? "", quote: want.quote, added_from: body.added_from, created_at: iso(now()) };
      pending.push(row);
      return { status: 201, body: rowOut(row) };
    }
    const dm = /^\/workbench\/contract\/documents\/pending-refs\/([^/]+)$/.exec(p);
    if (dm && method === "DELETE") {
      const id = decodeURIComponent(dm[1]);
      const i = UUIDISH.test(id) ? pending.findIndex((r) => r.id === id && r.owner === who.sub) : -1;
      if (i < 0) return err(404, "no such pending reference");
      pending.splice(i, 1);
      return { status: 200, body: { removed: id } };
    }
    return null;
  }

  // handle(person, method, url, body) -> { status, body, headers? } | null (null: not one of these routes)
  function handle(person, method, url, body = {}) {
    const who = PEOPLE[person];
    const u = new URL(url, "http://x");
    const p = u.pathname;
    const mine = p.startsWith("/workbench/settings") || p.startsWith("/workbench/contract/source-states") || p.startsWith("/workbench/contract/search") || p.startsWith("/workbench/contract/documents/pending-refs");
    if (!mine) return null;
    if (!who) return err(401, "sign in");
    if (p.startsWith("/workbench/settings")) return settings(person, who, method, p, u, body);
    if (p === "/workbench/contract/source-states" && method === "POST") return sourceStates(body);
    if (p === "/workbench/contract/search" && method === "GET") return search(u);
    return pendingRefs(who, method, p, u, body);
  }

  return {
    handle, reset,
    // test and stub controls (not routes)
    setLifecycle(id, lifecycle) { const s = sources.get(id); if (s) s.lifecycle = lifecycle; },
    erase(id) { const s = sources.get(id); if (s) { sources.delete(id); tombstones.set(id, { id: "d3000000-0000-4000-8000-0000000000ff", url: s.url }); } },
    rename(id, title) { const s = sources.get(id); if (s) s.title = title; },
    pendingRows() { return pending.map((r) => ({ ...r })); },
    account(person) { return Object.fromEntries([...accounts[person].entries()].map(([k, v]) => [k, { ...v }])); },
    plantAccount(person, key, value) { const c = cur(person, key); accounts[person].set(key, { value, version: c + 1 }); accounts.tomb[person].delete(key); },
    privateClaimOwner(id) { return privateClaims.get(id) ?? null; },
    sourceTitle(id) { return sources.get(id)?.title ?? held.get(id)?.title ?? null; },
  };
}
