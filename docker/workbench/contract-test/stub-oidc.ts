// A lab OpenID provider (rw-identity), for the disposable identity test network only. It plays
// Authentik's part in the authorization code flow, strictly:
//   GET  <issuer>.well-known/openid-configuration   discovery (issuer = STUB_ISSUER, Authentik-shaped)
//   GET  /authorize    response_type=code; client_id and redirect_uri exactly as registered;
//                      code_challenge_method=S256 and a code_challenge REQUIRED; state and nonce
//                      required; signs in the user named by login_hint (the lab's "sign-in page")
//                      and redirects back with a single-use code (60 s)
//   POST /token        client_secret_basic; the code once; redirect_uri as at /authorize;
//                      S256(code_verifier) must equal the code_challenge (else invalid_grant);
//                      an RS256 ID token (iss, aud, sub, exp, iat, nonce, name, email, groups)
//   GET  /jwks         the signing key
//   GET  /end-session  the provider's logout page
//   POST /__mode {"wrong_nonce": true}   the NEXT ID token carries another nonce (one-shot)
//   GET  /__log        what it saw (authorize: which PKCE method, state/nonce present; token: pkce ok/mismatch)
// TLS from STUB_CERT / STUB_KEY (the workbench refuses an http issuer). Never on a live network.
const issuer = Deno.env.get("STUB_ISSUER")!; // e.g. https://stub-oidc:8443/application/o/lab/
const clientId = Deno.env.get("STUB_CLIENT_ID")!;
const clientSecret = Deno.env.get("STUB_CLIENT_SECRET")!;
const redirects = (Deno.env.get("STUB_REDIRECT_URIS") ?? "").split(/[\s,]+/).filter(Boolean);
const users = JSON.parse(Deno.env.get("STUB_USERS") ?? "[]") as { login: string; sub: string; name: string; email?: string; groups: string[] }[];
const origin = new URL(issuer).origin;
const issuerPath = new URL(issuer).pathname;

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
const sha = async (s: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));

const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pub = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "lab-1", use: "sig", alg: "RS256" };
delete (pub as Record<string, unknown>).key_ops;
delete (pub as Record<string, unknown>).ext;

const codes = new Map<string, { user: (typeof users)[number]; challenge: string; nonce: string; redirect: string; exp: number }>();
const log: Record<string, unknown>[] = [];
let mode: { wrong_nonce?: boolean } = {};

async function sign(claims: Record<string, unknown>) {
  const data = `${enc({ alg: "RS256", kid: "lab-1", typ: "JWT" })}.${enc(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(data)));
  return `${data}.${b64url(sig)}`;
}
const err = (status: number, error: string) => Response.json({ error }, { status });

Deno.serve({ port: 8443, cert: Deno.readTextFileSync(Deno.env.get("STUB_CERT")!), key: Deno.readTextFileSync(Deno.env.get("STUB_KEY")!) }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname === `${issuerPath}.well-known/openid-configuration`) {
    return Response.json({
      issuer, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks`,
      end_session_endpoint: `${origin}/end-session`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["RS256"], subject_types_supported: ["public"],
    });
  }
  if (u.pathname === "/jwks") return Response.json({ keys: [pub] });
  if (u.pathname === "/end-session") return new Response("signed out of the lab provider", { status: 200 });
  if (u.pathname === "/__log") return Response.json({ events: log });
  if (u.pathname === "/__mode" && req.method === "POST") {
    mode = await req.json();
    return Response.json({ mode });
  }
  if (u.pathname === "/authorize" && req.method === "GET") {
    const q = Object.fromEntries(u.searchParams);
    log.push({ type: "authorize", method: q.code_challenge_method ?? null, challenge: !!q.code_challenge, state: !!q.state, nonce: !!q.nonce, scope: q.scope });
    if (q.response_type !== "code") return err(400, "unsupported_response_type");
    if (q.client_id !== clientId) return err(400, "invalid_client");
    if (!redirects.includes(q.redirect_uri)) return err(400, "invalid redirect_uri");
    if (q.code_challenge_method !== "S256" || !q.code_challenge) return err(400, "PKCE S256 required");
    if (!q.state || !q.nonce) return err(400, "state and nonce required");
    const user = users.find((x) => x.login === q.login_hint);
    if (!user) return err(400, "no such lab user (login_hint)");
    const code = b64url(crypto.getRandomValues(new Uint8Array(24)));
    codes.set(code, { user, challenge: q.code_challenge, nonce: q.nonce, redirect: q.redirect_uri, exp: Date.now() + 60_000 });
    const back = new URL(q.redirect_uri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.state);
    return new Response(null, { status: 302, headers: { location: back.toString() } });
  }
  if (u.pathname === "/token" && req.method === "POST") {
    const auth = req.headers.get("authorization") ?? "";
    const [id, secret] = auth.startsWith("Basic ") ? atob(auth.slice(6)).split(":").map(decodeURIComponent) : ["", ""];
    const f = new URLSearchParams(await req.text());
    const entry = codes.get(f.get("code") ?? "");
    codes.delete(f.get("code") ?? "");
    if (id !== clientId || secret !== clientSecret) { log.push({ type: "token", client: "refused" }); return err(401, "invalid_client"); }
    if (f.get("grant_type") !== "authorization_code" || !entry || entry.exp < Date.now()) { log.push({ type: "token", code: "refused" }); return err(400, "invalid_grant"); }
    if (f.get("redirect_uri") !== entry.redirect) { log.push({ type: "token", redirect: "mismatch" }); return err(400, "invalid_grant"); }
    const verifier = f.get("code_verifier") ?? "";
    const pkce = verifier && (await sha(verifier)) === entry.challenge ? "ok" : "mismatch";
    log.push({ type: "token", pkce });
    if (pkce !== "ok") return err(400, "invalid_grant (PKCE)");
    const now = Math.floor(Date.now() / 1000);
    const nonce = mode.wrong_nonce ? "a-nonce-from-another-sign-in" : entry.nonce;
    mode = {};
    const id_token = await sign({
      iss: issuer, aud: clientId, sub: entry.user.sub, exp: now + 300, iat: now, auth_time: now, nonce,
      name: entry.user.name, email: entry.user.email ?? `${entry.user.login}@lab.invalid`, preferred_username: entry.user.login, groups: entry.user.groups,
    });
    return Response.json({ access_token: b64url(crypto.getRandomValues(new Uint8Array(24))), token_type: "Bearer", expires_in: 300, id_token });
  }
  return err(404, "not found");
});
