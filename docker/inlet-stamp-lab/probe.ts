// probe.ts - rw-inlet-stamp's lab: the database's refusal through the REST door (PostgREST behind the real Caddyfile),
// one request per writer shape, and the readers' owner rule (plan 08 PD2). Prints one line, `PROBE {json}`:
//   writes: { <case>: { status, refused } }   (refused = the answer names slot 470's guard or check)
//   reads:  { <case>: <number of rows carrying a marker> }
// Env: REST (http://openbrain-rest), OWNER_A, OWNER_B, MARK_A, MARK_B, LABTAG (a per-run tag on every row it writes).
const REST = (Deno.env.get("REST") ?? "http://openbrain-rest").replace(/\/+$/, "") + "/rest/v1";
const A = Deno.env.get("OWNER_A") ?? "", B = Deno.env.get("OWNER_B") ?? "";
const MA = Deno.env.get("MARK_A") ?? "", MB = Deno.env.get("MARK_B") ?? "";
const TAG = Deno.env.get("LABTAG") ?? "probe";
const H = { "Content-Type": "application/json", Accept: "application/json", apikey: "local-trust", Prefer: "return=representation" };
const VEC = (() => { const v = new Array(1024).fill(0); v[0] = 1; return v; })();

// a door token (slot 450's shape: role + verified sub), signed with the lab PostgREST's secret
const SECRET = Deno.env.get("JWT_SECRET") ?? "";
const b64u = (b: Uint8Array | string) => btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function jwt(claims: Record<string, unknown>): Promise<string> {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" })), body = b64u(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64u(sig)}`;
}
async function post(path: string, body: unknown, token?: string) {
  const r = await fetch(`${REST}/${path}`, { method: "POST", headers: token ? { ...H, Authorization: `Bearer ${token}` } : H, body: JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, refused: /inlet stamp|inlet_stamp_owner_ok|inlet_subject_ok/.test(t), text: t };
}
const thought = (extra: Record<string, unknown>, meta: Record<string, unknown>) => ({
  content: `probe ${TAG} ${JSON.stringify(meta).slice(0, 40)}`, exposure: "ops", embedding: VEC,
  metadata: { exposure: "ops", lab_probe: TAG, ...meta }, ...extra,
});

const writes: Record<string, { status: number; refused: boolean; why?: string }> = {};
const w = async (name: string, path: string, body: unknown, token?: string) => {
  const r = await post(path, body, token);
  // the database's own message (never row content) for any answer that is not a 2xx
  writes[name] = { status: r.status, refused: r.refused, ...(r.status >= 300 ? { why: r.text.replace(/[^ -~]/g, "").slice(0, 160) } : {}) };
};
// the gmail pull's shape (pull-gmail.ts insertThoughtRow): no owner, then the wrong owner, then right
await w("pull shape, no owner", "thoughts", thought({}, { source: "gmail", gmail_id: `p-${TAG}-1` }));
await w("pull shape, owner but no connection", "thoughts", thought({ user_id: A }, { source: "gmail", gmail_id: `p-${TAG}-2` }));
await w("pull shape, A's row naming B's connection", "thoughts", thought({ user_id: A }, { source: "gmail", gmail_id: `p-${TAG}-3`, inlet_connection: "gmail-b" }));
await w("pull shape, unknown connection", "thoughts", thought({ user_id: A }, { source: "gmail", gmail_id: `p-${TAG}-4`, inlet_connection: "nobody" }));
await w("pull shape, the literal operator", "thoughts", thought({ user_id: "operator" }, { source: "gmail", gmail_id: `p-${TAG}-5`, inlet_connection: "gmail" }));
await w("pull shape, a service principal", "thoughts", thought({ user_id: "service:gmail-pull" }, { source: "gmail", gmail_id: `p-${TAG}-6`, inlet_connection: "gmail" }));
await w("pull shape, blank owner", "thoughts", thought({ user_id: "" }, { source: "gmail", gmail_id: `p-${TAG}-7`, inlet_connection: "gmail" }));
await w("pull shape, owned right (control)", "thoughts", thought({ user_id: A }, { source: "gmail", gmail_id: `p-${TAG}-8`, inlet_connection: "gmail" }));
// the import scripts' shape (google-activity / chatgpt): no owner
await w("import shape, no owner", "thoughts", thought({}, { source: "google_activity" }));
await w("import shape, owned (control)", "thoughts", thought({ user_id: B }, { source: "chatgpt" }));
// a door caller (slot 450's import role, its token's verified subject A) - the stamp is never a caller-chosen other owner
const importA = await jwt({ role: "ob_rest_import", sub: A });
await w("import token for A, a row with B's user_id", "thoughts", thought({ user_id: B }, { source: "chatgpt" }), importA);
await w("import token for A, a row naming B's connection", "thoughts", thought({ user_id: B }, { source: "gmail", gmail_id: `p-${TAG}-9`, inlet_connection: "gmail-b" }), importA);
await w("import token for A, A's own row (control)", "thoughts", thought({ user_id: A }, { source: "chatgpt" }), importA);
// the wiki note mirror's shape (wiki-service.mjs)
await w("note shape, no owner", "thoughts", thought({}, { source: "user_note", note_path: `notes/notebooks/lab/${TAG}.md` }));
await w("note shape, the vault's owner (control)", "thoughts", thought({ user_id: A }, { source: "user_note", note_path: `notes/notebooks/lab/${TAG}-2.md`, inlet_connection: "vault" }));
await w("note shape, B on the vault", "thoughts", thought({ user_id: B }, { source: "user_note", note_path: `notes/notebooks/lab/${TAG}-3.md`, inlet_connection: "vault" }));
// the compile's dossier: shared, the one exemption - and a look-alike without the compile's stamp
await w("dossier, unowned (control)", "thoughts", thought({}, { type: "dossier", generated_by: "recipes/entity-wiki/generate-wiki.mjs", wiki_slug: `lab-${TAG}` }));
await w("dossier look-alike, unowned", "thoughts", thought({}, { type: "dossier", wiki_slug: `lab-${TAG}-2` }));
// shared sources may never be personal
const src = (o: Record<string, unknown>) => ({ title: `probe ${TAG}`, content: `probe ${TAG}`, content_type: "web_article", metadata: {}, ...o });
await w("source, an email body", "sources", src({ url: `https://mail.google.com/mail/u/0/#inbox/${TAG}` }));
await w("source, a podcast transcript", "sources", src({ url: `https://example.org/${TAG}/t`, content_type: "podcast_transcript" }));
await w("source, a Gmail id", "sources", src({ url: `https://example.org/${TAG}/g`, metadata: { gmail_id: "abc" } }));
await w("source, a public article (control)", "sources", src({ url: `https://example.org/${TAG}/article` }));
// the podcast episode's owner
const ep = (owner: string, n: string) => ({ owner_sub: owner, shared: false, origin: "render", title: `probe ${TAG} ${n}`, team_id: null, audio_format: "mp3", seconds: 1, archive_dir: `/tmp/${TAG}-${n}` });
await w("episode, the literal operator (allowed on the column: the workbench labs' user)", "podcast_episodes", ep("operator", "op"));
await w("episode, a service principal", "podcast_episodes", ep("service:podcast", "svc"));
await w("episode, A (control)", "podcast_episodes", ep(A, "a"));

// the record itself: no app role reads it; the owner function answers a known connection only
const recRead = await fetch(`${REST}/inlet_connections?select=owner_sub`, { headers: H });
const recText = await recRead.text();
const own = async (id: string) => {
  const r = await fetch(`${REST}/rpc/inlet_connection_owner`, { method: "POST", headers: H, body: JSON.stringify({ p_id: id }) });
  const t = await r.text();
  return { status: r.status, same: { A: t === JSON.stringify(A), B: t === JSON.stringify(B) } };
};
const record = { table_read_status: recRead.status, table_read_gave_rows: /owner_sub/.test(recText), gmail: await own("gmail"), "gmail-b": await own("gmail-b"), vault: await own("vault"), nobody: await own("nobody") };

// the readers (slot 440's rules): B's and A's views of the marked rows
const count = async (path: string, init?: RequestInit) => {
  const r = await fetch(`${REST}/${path}`, { headers: H, ...init });
  const t = await r.text();
  return { a: t.split(MA).length - 1, b: t.split(MB).length - 1, status: r.status };
};
const match = (scope: string) => count("rpc/match_thoughts", { method: "POST", body: JSON.stringify({ query_embedding: VEC, match_threshold: -1, match_count: 100000, filter: { owner_scope: scope } }) });
const reads = {
  "match_thoughts as B": await match(B),
  "match_thoughts as A": await match(A),
  "match_thoughts shared only (the wiki compile)": await match("shared"),
  "the wiki compile's thoughts read (user_id=is.null)": await count("thoughts?select=id,content,metadata&user_id=is.null&limit=100000"),
};
console.log(`PROBE ${JSON.stringify({ writes, record, reads })}`);
