// rest-door-probe.mjs - rw-rest-door-auth lab probe (run-rest-door-auth-lab.ps1). Runs in a node container on the
// lab's internal network against the lab's REAL PostgREST (openbrain-postgrest:3000) behind the REAL Caddy door
// (openbrain-rest). Lab only: synthetic data, a lab secret; never point it at a live stack.
//   node rest-door-probe.mjs /cfg/probe.json
// Prints `PASS [case] ...` / `FAIL [case] ...` (GREEN) and, with cfg.red, `RED-OK [case] ...` when the base shows the
// defect the case exists for (`RED-UNEXPECTED-PASS [case]` when it does not). Ends with `PROBE OK` / `PROBE FAILED`.
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const REST = cfg.rest.replace(/\/+$/, "") + "/rest/v1";   // through the Caddy door
const PGRST = cfg.pgrst.replace(/\/+$/, "");             // straight to PostgREST on the plane network
const RED = !!cfg.red;
const cat = cfg.catalog ?? JSON.parse(readFileSync(cfg.catalogFile, "utf8"));
// a function is called with every one of its IN arguments named (null), so PostgREST resolves it and the call
// reaches the database's privilege check (an empty body would stop at "no function with these arguments")
const fnBody = (f) => Object.fromEntries((f.args ?? []).map((a) => [a, null]));
const fnNames = cat.functions.map((f) => f.name);
let fails = 0;
const outcomes = {};
const log = [];
function result(id, ok, msg) {
  // GREEN: ok = the check holds. RED: ok = the check holds on the base too (the defect is NOT there) -> unexpected.
  outcomes[id] ??= { ok: true, n: 0 };
  outcomes[id].n++;
  if (!ok) outcomes[id].ok = false;
  if (!ok) log.push(`  [${id}] ${msg}`);
}
function report(id, what) {
  const o = outcomes[id] ?? { ok: true, n: 0 };
  if (RED && id !== "6-health") {
    if (!o.ok) console.log(`RED-OK [${id}] ${what} - the base fails it (${log.filter((l) => l.includes(`[${id}]`)).length} of ${o.n})`);
    else { console.log(`RED-UNEXPECTED-PASS [${id}] ${what} (${o.n} checks held on the base)`); fails++; }
  } else {
    if (o.ok) console.log(`PASS [${id}] ${what} (${o.n} checks)`);
    else { console.log(`FAIL [${id}] ${what}`); for (const l of log.filter((l) => l.includes(`[${id}]`)).slice(0, 25)) console.log(l); fails++; }
  }
}

// ---- tokens ---------------------------------------------------------------------------------------------
const b64u = (s) => Buffer.from(s).toString("base64url");
function jwt(claims, secret = cfg.secret, alg = "HS256") {
  const h = b64u(JSON.stringify({ alg, typ: "JWT" })), p = b64u(JSON.stringify(claims));
  if (alg === "none") return `${h}.${p}.`;
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}
const T = cfg.tokens; // the mint script's tokens, by caller key (WIKI, VIEWER, ...)

async function call(base, method, path, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (raw) Object.assign(h, raw);
  if (body !== undefined) h["content-type"] = "application/json";
  try {
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, text: text.slice(0, 400), json };
  } catch (e) {
    return { status: 0, text: String(e?.message ?? e), json: null };
  }
}
const refused = (r) => r.status === 401 || r.status === 403;
const okish = (r) => r.status >= 200 && r.status < 300;

// ---- [1] unauthenticated: every table / view and every function, both doors ------------------------------
async function caseUnauth() {
  for (const rel of cat.relations) {
    for (const [door, base, p] of [["caddy", REST, `/${rel}?limit=0`], ["postgrest", PGRST, `/${rel}?limit=0`]]) {
      const r = await call(base, "GET", p);
      result("1-unauth", refused(r), `GET ${door} ${rel} -> ${r.status} ${r.text.slice(0, 80)}`);
    }
    // the apikey header alone (supabase-js convention) is no credential either
    const r2 = await call(REST, "GET", `/${rel}?limit=0`, { raw: { apikey: "local-trust" } });
    result("1-unauth", refused(r2), `GET caddy ${rel} with apikey only -> ${r2.status}`);
  }
  for (const f of cat.functions) {
    for (const [door, base] of [["caddy", REST], ["postgrest", PGRST]]) {
      const r = await call(base, "POST", `/rpc/${f.name}`, { body: fnBody(f) });
      result("1-unauth", refused(r), `POST ${door} rpc/${f.name} -> ${r.status} ${r.text.slice(0, 80)}`);
    }
  }
  // the OpenAPI root
  for (const [door, base] of [["caddy", REST], ["postgrest", PGRST]]) {
    const r = await call(base, "GET", "/");
    result("1-unauth", refused(r), `GET ${door} / (OpenAPI) -> ${r.status}`);
  }
  report("1-unauth", `unauthenticated: ${cat.relations.length} relations and ${cat.functions.length} functions (generated from the catalog), through Caddy and straight to PostgREST, all refused`);
}

// ---- [2] each caller works with its own token; and is refused what it does not use -------------------------
const S = cfg.seed;
async function asCaller(key, steps) {
  for (const [what, method, path, body, headers] of steps) {
    const r = await call(REST, method, path, { token: T[key], body, headers });
    result(`2-caller-${key}`, okish(r), `${key}: ${what} ${method} ${path} -> ${r.status} ${r.text.slice(0, 160)}`);
    if (!okish(r) && RED) { /* the base has no tokens: its door strips them, so this mostly passes there */ }
  }
}
const zeros = `[${new Array(1024).fill(0.01).join(",")}]`;
async function casePositive() {
  const note = `lab-note-${Date.now()}`;
  await asCaller("WIKI", [
    ["readiness", "GET", "/entities?select=id&limit=1"],
    ["changed entities", "GET", `/entities?select=id&updated_at=gte.2000-01-01T00:00:00Z&order=id.asc&limit=10`],
    ["link snapshot", "GET", "/entities?select=id,canonical_name,entity_type,metadata,updated_at&limit=10"],
    ["link snapshot", "GET", "/thought_entities?select=entity_id&limit=10"],
    ["link snapshot", "GET", "/source_entities?select=entity_id,sources!inner(id)&sources.retraction_committed_at=is.null&limit=10"],
    ["notebook sweep", "GET", "/threads?select=slug,status&status=eq.active"],
    ["change watch", "GET", "/sources?select=id&or=(created_at.gt.2000-01-01,updated_at.gt.2000-01-01)&limit=200"],
    ["change watch", "GET", "/thoughts?select=id&or=(created_at.gt.2000-01-01,updated_at.gt.2000-01-01)&limit=200"],
    ["edges", "GET", `/edges?select=*&from_entity_id=eq.${S.entityId}`],
    ["thread sources", "GET", "/thread_sources?select=source_id,status&status=eq.confirmed&limit=5"],
    ["leaf thoughts", "GET", `/thought_entities?select=thought_id,thoughts(id,content,metadata)&entity_id=eq.${S.entityId}`],
    ["note mirror insert", "POST", "/thoughts", { content: `wiki note ${note}`, metadata: { note_path: `notes/${note}.md`, exposure: "ops" }, exposure: "ops" }, { prefer: "return=representation" }],
    ["note mirror read", "GET", `/thoughts?select=id&metadata->>note_path=eq.notes/${note}.md`],
    ["note mirror patch", "PATCH", `/thoughts?metadata->>note_path=eq.notes/${note}.md`, { content: `wiki note ${note} edited` }, { prefer: "return=minimal" }],
    ["note mirror delete", "DELETE", `/thoughts?metadata->>note_path=eq.notes/${note}.md`, undefined, { prefer: "return=minimal" }],
    ["pin entity slug", "PATCH", `/entities?id=eq.${S.entityId}`, { metadata: { wiki_slug: "tool/lab-entity" } }, { prefer: "return=minimal" }],
    ["new thread", "POST", "/threads", { name: `Lab thread ${note}`, slug: `lab-thread-${note}` }, { prefer: "return=representation" }],
    ["thread slug", "PATCH", `/threads?slug=eq.lab-thread-${note}`, { slug: `lab-thread-${note}-x` }, { prefer: "return=minimal" }],
    ["page upsert", "POST", "/wiki_pages?on_conflict=slug&select=slug", [{ slug: `content/lab/${note}`, page_class: "entity", title: "Lab page", body: "lab body", links: [] }], { prefer: "resolution=merge-duplicates,return=representation" }],
    ["page re-read", "GET", `/wiki_pages?select=slug&slug=in.("content/lab/${note}")`],
    ["page delete", "DELETE", `/wiki_pages?slug=in.("content/lab/${note}")`, undefined, { prefer: "return=representation" }],
    ["notification", "POST", "/rpc/post_research_notification", { p_class: S.notifyClass, p_subject: "lab compile notice", p_slug: null, p_entity: null, p_error: null }],
  ]);
  report("2-caller-WIKI", "openbrain-wiki with its own token: every inventoried request answers 2xx");
  await asCaller("VIEWER", [
    ["probe", "GET", "/wiki_pages?select=slug&limit=1"],
    ["row", "GET", `/wiki_pages?slug=eq.${encodeURIComponent(S.wikiSlug)}&select=slug,title,body&limit=1`],
    ["nav", "GET", "/wiki_pages?select=slug,title,page_class&order=slug.asc&limit=50&slug=gt."],
    ["signature", "GET", "/wiki_pages?select=updated_at&order=updated_at.desc.nullslast&limit=1", undefined, { prefer: "count=exact" }],
    ["repair upsert", "POST", "/wiki_pages?on_conflict=slug&select=slug", [{ slug: S.wikiSlug, page_class: "entity", title: "Lab Wiki Page", body: "lab body repaired", links: [] }], { prefer: "resolution=merge-duplicates,return=representation" }],
  ]);
  report("2-caller-VIEWER", "openbrain-wiki-viewer with its own token: reads and the repair upsert answer 2xx");
  await asCaller("ENTITY", [
    ["peek queue", "GET", "/entity_extraction_queue?select=thought_id,status&status=eq.pending&limit=5"],
    ["claim queue", "PATCH", `/entity_extraction_queue?thought_id=eq.${S.thoughtId}&status=eq.pending`, { status: "processing" }, { prefer: "return=representation" }],
    ["thought", "GET", `/thoughts?select=id,content,metadata&id=eq.${S.thoughtId}`],
    ["upsert entity", "POST", "/entities?on_conflict=entity_type,normalized_name&select=id", { entity_type: "tool", canonical_name: "Lab Worker Entity", normalized_name: "lab worker entity" }, { prefer: "resolution=merge-duplicates,return=representation" }],
    ["link thought", "POST", "/thought_entities?on_conflict=thought_id,entity_id,mention_role", { thought_id: S.thoughtId, entity_id: S.entityId, mention_role: "mentioned", source: "entity_worker" }, { prefer: "resolution=merge-duplicates,return=minimal" }],
    ["edges read", "GET", `/edges?select=id,support_count&from_entity_id=eq.${S.entityId}&to_entity_id=eq.${S.entity2Id}`],
    ["edge insert", "POST", "/edges", { from_entity_id: S.entityId, to_entity_id: S.entity2Id, relation: "related_to", support_count: 1, confidence: 0.5 }, { prefer: "return=representation" }],
    ["unlink thought", "DELETE", `/thought_entities?thought_id=eq.${S.thoughtId}&source=eq.entity_worker`, undefined, { prefer: "return=minimal" }],
    ["complete", "PATCH", `/entity_extraction_queue?thought_id=eq.${S.thoughtId}`, { status: "complete" }, { prefer: "return=minimal" }],
    ["source queue", "GET", "/source_extraction_queue?select=source_id,status&status=eq.pending&limit=5"],
    ["source", "GET", `/sources?select=id,content&id=eq.${S.sourceId}`],
    ["link source", "POST", "/source_entities?on_conflict=source_id,entity_id", { source_id: S.sourceId, entity_id: S.entityId, mention_role: "mentioned" }, { prefer: "resolution=ignore-duplicates,return=minimal" }],
    ["unlink source", "DELETE", `/source_entities?source_id=eq.${S.sourceId}&mention_role=neq.user_linked`, undefined, { prefer: "return=minimal" }],
  ]);
  report("2-caller-ENTITY", "openbrain-entity-worker with its own token: every inventoried request answers 2xx");
  await asCaller("DIGEST", [
    ["recent", "GET", "/thoughts?select=id,content,metadata,created_at&created_at=gte.2000-01-01T00:00:00Z&order=created_at.desc&limit=5&metadata->>type=not.eq.profile_field"],
    ["profile", "GET", "/thoughts?select=content&metadata->>type=eq.profile_field&metadata->>field_name=eq.address&order=created_at.desc&limit=1"],
    ["semantic", "POST", "/rpc/match_thoughts", { query_embedding: zeros, match_threshold: 0.0, match_count: 3, filter: {} }],
    ...(RED ? [] : [["setting", "POST", "/rpc/rest_setting_get", { p_key: "digest.window_hours" }]]),
  ]);
  report("2-caller-DIGEST", "openbrain-digest with its own token: every inventoried request answers 2xx");
  await asCaller("PODCAST", [
    ["request", "GET", `/podcast_render_requests?id=eq.${S.renderId}&select=*`],
    ["request state", "PATCH", `/podcast_render_requests?id=eq.${S.renderId}`, { state: "rendering" }, { prefer: "return=minimal" }],
    ["team", "GET", `/podcast_teams?select=id,name,podcast_team_members(position,podcast_presenters(id,name,podcast_voice_links(id,route,voice,speed)))&owner_sub=eq.${S.owner}&id=eq.${S.teamId}`],
    ["episode", "POST", "/podcast_episodes", { owner_sub: S.owner, title: "Lab episode", team_id: S.teamId, audio_format: "mp3", archive_dir: "/lab/ep" }, { prefer: "return=representation" }],
    ["episode read", "GET", `/podcast_episodes?owner_sub=eq.${S.owner}&select=archive_dir&limit=1`],
    ["gmail thoughts", "GET", "/thoughts?metadata->>gmail_id=eq.lab-gmail-1&limit=200"],
    // rw-boundary-digest (slot 460): the loop-close stores the transcript on the owner's episode row (setTranscript)
    ...(cat.hasTranscript ? [["transcript", "PATCH", `/podcast_episodes?id=eq.${S.episodeId}&owner_sub=eq.${S.owner}&select=id`, { transcript: "lab transcript" }, { prefer: "return=representation" }]] : []),
    ...(RED ? [] : [["setting", "POST", "/rpc/rest_setting_get", { p_key: "podcast.team" }]]),
  ]);
  report("2-caller-PODCAST", "openbrain-podcast with its own token: every inventoried request answers 2xx");
  await asCaller("GMAIL_PULL", [
    ["insert", "POST", "/thoughts", { content: `lab gmail ${Date.now()}`, metadata: { source: "gmail", gmail_id: "lab-gmail-2", email_date: "2001-01-01", exposure: "ops" }, exposure: "ops" }, { prefer: "return=representation" }],
  ]);
  report("2-caller-GMAIL_PULL", "openbrain-gmail-pull with its own token: the insert answers 2xx");
  await asCaller("GMAIL_PRUNE", [
    ["preview", "GET", "/thoughts?select=id,metadata,content&metadata->>source=eq.gmail&metadata->>email_date=lt.2002-01-01&order=metadata->>email_date.asc&limit=10000"],
    ["delete", "DELETE", `/thoughts?id=in.(${S.pruneThoughtId})&select=id`, undefined, { prefer: "return=representation" }],
  ]);
  report("2-caller-GMAIL_PRUNE", "openbrain-gmail-prune with its own token: preview and delete answer 2xx");
}

// what a caller does not use: every relation it holds no SELECT on and every function it holds no EXECUTE on
async function caseNegative() {
  for (const [key, role] of Object.entries(cfg.roles)) {
    const allowedRel = new Set(cat.allowed[role]?.relations ?? []);
    const allowedFn = new Set(cat.allowed[role]?.functions ?? []);
    for (const rel of cat.relations.filter((r) => !allowedRel.has(r))) {
      const r = await call(REST, "GET", `/${rel}?limit=1`, { token: T[key] });
      result("2-least", refused(r), `${key} GET ${rel} -> ${r.status} ${r.text.slice(0, 80)}`);
    }
    for (const f of cat.functions.filter((f) => !allowedFn.has(f.name))) {
      const r = await call(REST, "POST", `/rpc/${f.name}`, { token: T[key], body: fnBody(f) });
      // a function whose arguments have no names cannot be addressed through PostgREST at all (PGRST202); the role's
      // lack of EXECUTE on it is in the catalog list this loop runs over
      const unaddressable = !f.args.length && f.nargs > 0 && r.status === 404 && /PGRST202/.test(r.text);
      result("2-least", refused(r) || unaddressable, `${key} rpc/${f.name} -> ${r.status} ${r.text.slice(0, 80)}`);
    }
  }
  // the granted sets are exactly the door map (no "near" grant crept in)
  if (!RED) {
    for (const [role, want] of Object.entries(cfg.expectedMap ?? {})) {
      const got = (cat.allowed[role]?.relations ?? []).slice().sort().join(",");
      result("2-least", got === want.slice().sort().join(","), `${role} can SELECT [${got}], the map says [${want.slice().sort().join(",")}]`);
    }
  }
  report("2-least", "each caller's token is refused every relation and function outside what that caller uses (generated per role)");
}

// ---- [3] forged / borrowed claims ---------------------------------------------------------------------------
async function caseForged() {
  const probe = "/wiki_pages?select=slug&limit=1";  // something the viewer may read
  const ideas = "/ideas?select=id&limit=1";
  // (the base has no tokens: there the viewer's is minted with the probe's secret, as the mint script would)
  const v = (T.VIEWER ?? "").split(".").length === 3 ? T.VIEWER : jwt({ role: "ob_rest_viewer", aud: "openbrain-rest", caller: "viewer" });
  const [h, p, s] = v.split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  const tampered = `${h}.${b64u(JSON.stringify({ ...claims, role: "ob_rest_wiki" }))}.${s}`;
  const forged = [
    ["the viewer's token with its role edited to ob_rest_wiki (signature kept)", tampered, "/thoughts?select=id&limit=1"],
    ["a token for ob_rest_wiki signed with another secret", jwt({ role: "ob_rest_wiki", aud: "openbrain-rest" }, "not-the-lab-secret-not-the-lab-secret-0123"), probe],
    ["alg none naming ob_rest_wiki", jwt({ role: "ob_rest_wiki", aud: "openbrain-rest" }, undefined, "none"), probe],
    ["alg none naming service_role", jwt({ role: "service_role", aud: "openbrain-rest" }, undefined, "none"), ideas],
    ["a valid signature for another audience", jwt({ role: "ob_rest_viewer", aud: "something-else" }), probe],
    ["an expired token", jwt({ role: "ob_rest_viewer", aud: "openbrain-rest", exp: 1000 }), probe],
  ];
  for (const role of ["service_role", "postgres", "ob_app_memory", "ob_plane_personal", "anon", "authenticated", "ob_rest_authenticator", "intake", "ob_pantry"]) {
    forged.push([`a VALID signature naming ${role} (the authenticator is not a member)`, jwt({ role, aud: "openbrain-rest" }), ideas]);
  }
  for (const [what, tok, path] of forged) {
    for (const [door, base] of [["caddy", REST], ["postgrest", PGRST]]) {
      const r = await call(base, "GET", path, { token: tok });
      result("3-forged", refused(r), `${what} via ${door} GET ${path} -> ${r.status} ${r.text.slice(0, 100)}`);
    }
  }
  report("3-forged", "a tampered role claim, a wrong secret, alg none, a wrong/missing audience, an expired token, and validly signed tokens naming service_role / postgres / ob_app_memory / anon / authenticated / the authenticator: all refused");
}

// ---- [4] owners: the token names the owner; nothing private is reachable --------------------------------------
async function caseOwner() {
  if (!RED) {
    const op = await call(REST, "POST", "/rpc/rest_setting_get", { token: T.DIGEST, body: { p_key: "digest.window_hours" } });
    result("4-owner", okish(op) && op.json === S.operatorWindow, `the digest's token (sub = the operator) reads the operator's window: ${op.status} ${op.text}`);
    const other = jwt({ role: "ob_rest_digest", aud: "openbrain-rest", caller: "digest", sub: S.other });
    const ot = await call(REST, "POST", "/rpc/rest_setting_get", { token: other, body: { p_key: "digest.window_hours" } });
    result("4-owner", okish(ot) && ot.json === S.otherWindow, `a token for a second user reads only the second user's window: ${ot.status} ${ot.text}`);
    const named = await call(REST, "POST", "/rpc/rest_setting_get", { token: other, body: { p_key: "digest.window_hours", p_owner: S.owner } });
    result("4-owner", !okish(named) || named.json !== S.operatorWindow, `naming the operator in the body changes nothing: ${named.status} ${named.text.slice(0, 100)}`);
    for (const [what, claims] of [["no sub", { role: "ob_rest_digest", aud: "openbrain-rest" }], ["a service sub", { role: "ob_rest_digest", aud: "openbrain-rest", sub: "service:digest" }], ["a blank sub", { role: "ob_rest_digest", aud: "openbrain-rest", sub: "  " }]]) {
      const r = await call(REST, "POST", "/rpc/rest_setting_get", { token: jwt(claims), body: { p_key: "digest.window_hours" } });
      result("4-owner", refused(r) || (r.status >= 400 && /42501|names no owner/.test(r.text)), `${what}: refused (${r.status} ${r.text.slice(0, 100)})`);
    }
  }
  // T3: each caller reads only its own user-tier keys; an admin-tier key never; a caller without settings none
  if (!RED) {
    const prefix = { DIGEST: "digest.", PODCAST: "podcast." };
    for (const key of Object.keys(cfg.roles)) {
      for (const k of cat.settingKeys ?? []) {
        const r = await call(REST, "POST", "/rpc/rest_setting_get", { token: T[key], body: { p_key: k.key } });
        const may = prefix[key] && k.key.startsWith(prefix[key]) && k.tier === "user";
        result("4-owner", may ? okish(r) : refused(r) || (r.status >= 400 && /42501|may not read/.test(r.text)),
          `${key} rest_setting_get(${k.key}, ${k.tier}) -> ${r.status} ${r.text.slice(0, 80)} (${may ? "its own key" : "not its key"})`);
      }
    }
  }
  // every owner-argument function, with every caller's token and with the second user's, naming the operator
  const tokens = { ...T, SECOND_USER: jwt({ role: "ob_rest_digest", aud: "openbrain-rest", sub: S.other }) };
  for (const [key, tok] of Object.entries(tokens)) {
    for (const f of cat.ownerFns) {
      const body = fnBody(f);
      if ("p_owner" in body) body.p_owner = S.owner;
      if ("p_key" in body) body.p_key = "digest.window_hours";
      const r = await call(REST, "POST", `/rpc/${f.name}`, { token: RED ? undefined : tok, body });
      result("4-owner", refused(r), `${RED ? "anonymous" : key} rpc/${f.name}(p_owner = the operator) -> ${r.status} ${r.text.slice(0, 100)}`);
    }
    // a private relation a caller legitimately reads (the podcast's presenter model, owner-stamped) is its own case 2;
    // here every OTHER one must be refused to that token
    const mine = new Set(RED ? [] : (cat.allowed[cfg.roles[key] ?? "ob_rest_digest"]?.relations ?? []));
    for (const rel of cat.privateRels.filter((r) => !mine.has(r))) {
      const r = await call(REST, "GET", `/${rel}?limit=5`, { token: RED ? undefined : tok });
      result("4-owner", refused(r), `${RED ? "anonymous" : key} GET ${rel} -> ${r.status} ${r.text.slice(0, 100)}`);
    }
    if (RED) break;
  }
  // a caller that reads thoughts sees the ops plane only: the operator's personal (owner-stamped) thought is not in it
  if (!RED) {
    for (const key of ["WIKI", "ENTITY", "DIGEST", "PODCAST", "GMAIL_PULL", "GMAIL_PRUNE"]) {
      const r = await call(REST, "GET", "/thoughts?select=id,exposure&user_id=not.is.null&exposure=neq.ops", { token: T[key] });
      result("4-owner", okish(r) && Array.isArray(r.json) && r.json.length === 0, `${key} reads no personal owner-stamped thought: ${r.status} ${r.text.slice(0, 80)}`);
    }
  }
  // and the owner-stamped thought is not readable without a credential (rw-inlet-owner finding 2's class)
  const st = await call(REST, "GET", "/thoughts?select=id&user_id=not.is.null");
  result("4-owner", refused(st), `anonymous GET thoughts?user_id=not.is.null -> ${st.status} ${st.text.slice(0, 80)}`);
  report("4-owner", `owners: rest_setting_get follows the token's sub; no caller and no second user can run an owner-argument function (${cat.ownerFns.length}) or read ideas, settings, hand-backs or private reports (${cat.privateRels.length} relations)`);
}

// ---- [6] the health paths answer without a credential -----------------------------------------------------------
async function caseHealth() {
  const root = cfg.rest.replace(/\/+$/, "");
  for (const p of ["/", "/healthz"]) {
    const r = await call(root, "GET", p);
    result("6-health", r.status === 200, `GET ${p} -> ${r.status}`);
  }
  if (!RED) {
    const r = await call(REST, "GET", "/thoughts?limit=0");
    result("6-health", r.status === 401 && /credentials required/.test(r.text), `Caddy answers a credential-less /rest/v1 request itself: ${r.status} ${r.text.slice(0, 60)}`);
    const r2 = await call(REST, "GET", "/thoughts?limit=0", { raw: { authorization: "Bearer not-a-jwt" } });
    result("6-health", r2.status === 401, `a bad Bearer reaches PostgREST and is refused there: ${r2.status} ${r2.text.slice(0, 80)}`);
  }
  report("6-health", "the door's health paths (/ and /healthz) answer 200 without a credential");
}

const only = (cfg.cases ?? "").split(",").filter(Boolean);
const want = (c) => !only.length || only.includes(c);
if (want("1")) await caseUnauth();
if (want("2")) { if (!RED) await casePositive(); await caseNegative(); }
if (want("3")) await caseForged();
if (want("4")) await caseOwner();
if (want("6")) await caseHealth();
if (cfg.out) writeFileSync(cfg.out, JSON.stringify({ outcomes, failures: log }, null, 1));
console.log(`PROBE ${fails ? "FAILED" : "OK"} (${fails} failed)`);
process.exit(fails ? 1 : 0);
