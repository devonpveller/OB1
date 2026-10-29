# openbrain-workbench

The browser-facing read/write API behind the Quartz viewer — the backend half
of the "Quartz as Open Brain workbench" plan
([quartz-4-expansion-plan.md](../../../documentation/implementation-guide/expand-quartz-4/quartz-4-expansion-plan.md)).
Deno + Hono, internal `PORT=8000`.

## Why it exists

A static Quartz page can't write Postgres. This service is the thin write-API
the in-Quartz client components (`NotebookPage.inline.ts`, `SourceEditor`,
`ImportDropzone`, the grounding badge, …) call via same-origin `fetch`. It is
kept **off** the MCP server + cloud-gateway (8-tool contract) so the
multipart/upload/auth surface stays isolated.

## How it's reached (§2.3)

```
browser ──fetch('/workbench/…')──> portal Caddy (wiki.{$PUBLIC_DOMAIN})
   Authelia forward_auth gate ─┐
   handle /workbench/*  ───────┴─> reverse_proxy openbrain-workbench:8000
                                   + header_up X-Brain-Key {$WORKBENCH_KEY}
```

- `handle` (NOT `handle_path`) preserves the `/workbench` prefix, so routes are
  mounted prefix-inclusive (`/workbench/notebooks`, …).
- Caddy **injects** the shared secret server-side (G7) — the browser never holds
  it. `requireBrainKey` trusts the header on `app-net`; the service is never
  host-published except an optional `127.0.0.1` debug port.

## Architecture (G9)

Hono **sub-routers per resource** over a thin **service → repository** layering:

```
src/
  main.ts             app wiring + auth gate + router mounts
  config.ts           env → config (one place)
  middleware/auth.ts  X-Brain-Key gate (G7)
  db/pool.ts          deno-postgres pool + withTransaction (G8, atomic writes)
  db/rest.ts          PostgREST read client (reads only)
  types.ts            shared schema-mirrored types (P0.7)
  routes/health.ts    P0 skeleton
  routes/<resource>   added per phase (notebooks P2, notes P3, sources P4,
                      import P5, grounding P6)
```

- **Writes** (multi-row logical units: import = source + chunks + links) go
  through `withTransaction` so a mid-sequence failure can't half-write (G8).
- **Reads** may use PostgREST (`db/rest.ts`).
- Path/asset normalization (no `../` escape) lives in ONE shared validator
  (added with the notes/import routes), never per-handler.

## Networks

`obnet` (PostgREST) + `llm-net` (embeddings) + `app-net` (portal-Caddy name
resolution — required, §2.3) + `search-gw-net` (= `ai-stack_default`: the `vpn` proxy the
export's resolver goes out through, research-workbench P6a).

## Env

`PORT`, `WORKBENCH_KEY` (= the `MCP_ACCESS_KEY` value), `DB_*`, the sign-in's `WORKSPACE_OIDC_*`,
`WORKSPACE_DOOR_KEY`, `WORKSPACE_SERVICE_KEYS`, `WORKSPACE_IDENTITY_HEADER` (see "Sign-in" below),
`OPEN_BRAIN_URL`, `EMBEDDING_*`, `EXTRACT_URL`, `WIKI_GIT_DIR`, `WIKI_OUT_DIR`,
`WIKI_ASSETS_DIR`, `CONTRACT_MOUNTS_ROOT` (default `/mounts`: where named mounts such as
`podcast-archive` live), `CONTRACT_STREAM_POLL_MS` (default `1000`).
The export's resolver (P6a): `OPENALEX_API_KEY`, `CROSSREF_MAILTO` (both blank = off), `FETCH_PROXY_URL`
(blank = refused, never direct); `RESOLVER_OPENALEX_BASE` / `RESOLVER_CROSSREF_BASE` / `RESOLVER_TIMEOUT_MS`
exist for the disposable test run's stub only.

## Sign-in with Authentik (rw-identity)

Shipped **inert**: with no `WORKSPACE_OIDC_*` set there is no sign-in, and the workspace is the one
`WORKSPACE_DEFAULT_SUB` user exactly as before. Configured, the research front end signs its users
in itself with OpenID Connect - the authorization code flow with PKCE (S256), a state bound to the
browser that started it (single use, 10 minutes) and a nonce checked in the ID token - the same way
Open WebUI signs its own users in (env-only provider settings; nothing in a database or a UI).

| Route | What |
|---|---|
| `GET /workbench/auth/login?return_to=` | starts a sign-in (302 to Authentik) |
| `GET /workbench/auth/callback` | Authentik's answer: state, code + verifier, ID token (signature RS256/ES256/HS256, iss, aud, azp, exp, iat, nonce) |
| `GET /workbench/auth/me` | who the request is (the workspace asks before it renders) |
| `POST /workbench/auth/logout` | revokes the session server-side, clears the cookie; offers Authentik's end-session URL |
| `POST /workbench/auth/impersonate {sub, reason}` / `.../impersonate/end` | admins only; a reason first (>= 8 letters or digits by Unicode category; nothing else counts) |
| `GET /workbench/auth/users`, `GET /workbench/auth/audit?actor&subject&action&since&limit` | admins only: whom to impersonate; the audit log |

- **Identity.** `subject_sub` = the Authentik `sub` of the signed-in user, `actor_sub` = the same user,
  except while an admin impersonates: then `subject_sub` is the user and `actor_sub` the admin, a
  banner shows it on every screen, and the switch plus **every request** of that session are written
  to `admin_audit` (actor, subject, reason, method, route, time) **before** the request runs - a
  request that cannot be recorded is refused (503). `admin_audit` is append-only: a trigger refuses
  UPDATE, DELETE and TRUNCATE for every role; the workbench's role has SELECT + INSERT only.
- **Cookies.** `__Host-ob-ws-session` (Secure, HttpOnly, SameSite=Strict, Path=/; the server keeps only
  the SHA-256 of its random token) and the sign-in binding `__Host-ob-ws-login` (SameSite=Lax: the
  provider's redirect back is a cross-site navigation; cleared at the callback).
- **Keys.** With sign-in on, `WORKSPACE_DOOR_KEY` is REQUIRED and must differ from `WORKBENCH_KEY`:
  the viewer's `/workbench` forwarder injects it for browsers (a request with it and no session gets
  401 outside `/workbench/auth`); `WORKBENCH_KEY` (= `MCP_ACCESS_KEY`, what openbrain-mcp's contract
  tools and openbrain-wiki send) becomes the internal service `service:internal`, which reads shared
  knowledge but has no user front end (403 on `/workbench/documents`, `/workbench/workspace`, the admin
  routes). `WORKSPACE_SERVICE_KEYS=name=key;...` adds named services.
- **The identity header cannot stand in for a sign-in.** While sign-in is configured
  `WORKSPACE_IDENTITY_HEADER` is ignored entirely. Without sign-in it is P2b's forward-auth hook, and
  then this **edge-strip rule** applies: every door in front of the workbench MUST remove any
  client-sent copy of that header (and of `WORKSPACE_IDENTITY_NAME_HEADER`) and set it itself, or any
  client can claim any subject. The viewer's forwarder drops both from every client request; a
  Traefik router in front of the viewer that sets the header needs a headers middleware that first
  deletes it (`customRequestHeaders: {<header>: ""}`), as does any other proxy.
- **Doors.** With sign-in on, browsers must reach the workbench only through the viewer (Traefik ->
  viewer, `WIKI_VIEWER_ALLOWED_HOSTS` / `_ORIGINS` = the edge's public name). The portal Caddy's
  `handle /workbench/*` route injects `MCP_ACCESS_KEY` - with sign-in on that would make a Caddy-path
  browser the internal service (shared knowledge, no user front end, no sign-in): remove that route
  or make it inject `WORKSPACE_DOOR_KEY` before turning sign-in on.
- **What another user (or an agent key) reads of a job** (round 4): an ALLOW-LIST - status, queue
  position, and of the result only the grounded report (synthesis, when the run found something), its
  cited sources (title, url), claims (id, text), outcome and report type; tree and events: ids, kinds,
  steps, status, time. The original prompt and everything derived from it (needs, follow-up queries,
  gaps, the failure notice, progress messages, errors, event payloads) are the owner's only - in the
  research service's reads and the workbench's session views alike. The failure notice no longer quotes
  the question. The route scope is judged on the decoded path (`/workbench/%64ocuments` = documents).
  With sign-in on and `WORKSPACE_DEFAULT_SUB` blank, every admin read of the job views is audited.
- **Acting on a job** (round 5): steering or cancelling a research job is its owner's alone - the user
  its prompt belongs to (through Open WebUI's or the workspace's key naming them), or the service that
  started it, or (no recorded owner) WORKSPACE_DEFAULT_SUB; anyone else gets 404, as for a missing job.
  Shared knowledge never receives the verbatim prompt: the curator files the derived question (the
  planner's needs) and no span of 5+ prompt words in needs, follow-ups or prose; the staging session
  names the run. The prompt itself stays in research_jobs / research_prompts, owner-scoped.
- **Egress.** The only new outbound calls: the issuer's discovery document, its keys and its token
  endpoint (https), only when `WORKSPACE_OIDC_ISSUER` is set. Nothing goes to a model provider.
- **Storage.** `init-identity.sql` (slot 290): `workspace_users`, `workspace_login_pending`,
  `workspace_sessions`, `admin_audit`. Revert: `revert-identity.sql` (discards the audit log - export it).

**The Authentik side** (the operator creates it; nothing here builds Authentik):
1. Providers -> Create -> *OAuth2/OpenID Provider*: name `research-workspace`; authorization flow
   *default-provider-authorization-implicit-consent* (or explicit); client type **Confidential**;
   redirect URI (strict) `https://<edge>/workbench/auth/callback`; signing key: the instance's
   certificate (RS256; without one Authentik signs HS256 with the client secret, also accepted); scopes
   `openid`, `email`, `profile` (Authentik's profile mapping carries the `groups` claim); subject mode
   *Based on the User's hashed ID* (the default - the SAME mode as Open WebUI's provider, so one user
   has one `sub` in both: 07-MULTI-USER "one user id everywhere"). Copy the client ID and secret.
2. Applications -> Create: name `Research workspace`, slug `research-workspace`, provider the one
   above; bind the users or group allowed to sign in. Issuer = `https://<authentik>/application/o/research-workspace/`.
3. Directory -> Groups: a group (e.g. `research-admins`) whose members may impersonate =
   `WORKSPACE_OIDC_ADMIN_GROUP`.
4. Optional: the provider's post-logout redirect `https://<edge>/workspace/` = `WORKSPACE_OIDC_POST_LOGOUT_URI`.

The lab: `contract-test/run-identity-tests.ps1` (a TLS lab provider, `contract-test/stub-oidc.ts`, with
two users, two more for the sweep and an admin; real sessions; the real research service image).

## The retrieval contract (research-workbench P0)

`src/contracts/` is the typed retrieval contract every panel and MCP client reads the
knowledge base through. Zod 4 schemas registered as `@hono/zod-openapi` routes, so the routes
ARE the document: `GET /openapi.json` (bare path, internal) and `GET /workbench/openapi.json`
(behind the key gate) serve it; `src/contracts/generated/` holds the committed copy, the
generated TypeScript types and the MCP tool manifest. Routes live under
`/workbench/contract/*`; the eleven pre-contract routers are untouched.

- **The API owns record states.** Every record carries `state` (a key of the `record_states`
  registry) and `state_detail`. Sources carry their D5 lifecycle (`held | active | suppressed
  | unlinked | erased`); `evidence_only=true` omits everything that is not evidence.
- **Expansion by registration (D18).** Every enumerated kind is a registry row
  (`contract_registries` / `contract_registry_entries`, plus `content_types`); schemas type them
  as strings annotated `x-registry`. The conformance test fails on any `enum`, `const`,
  `anyOf`, `allOf` or `oneOf` in the document.
- **Reads only over MCP (D14).** openbrain-mcp registers every operation marked `x-mcp-tool`
  from `../../integrations/kubernetes-deployment/contract-tools.json` and calls these routes.
  Writes (suppress, sever, erase, admission, held sources, hidden set, settings) are HTTP only.
- **Storage** is `../init-research-contract.sql` (initdb slot 230; revert:
  `../revert-research-contract.sql`).
- **Notices**: `THIRD-PARTY-NOTICES.md` (D9 rule 5), checked at every image build.

```
deno task contract:gen      # regenerate openapi.json, types.ts, mcp-tools.json (+ the MCP copy)
deno task contract:check    # fail when any generated artifact is stale
deno test --allow-net --allow-env --allow-read src/     # unit + document tests (DB tests skip)
powershell -NoProfile -File contract-test/run-contract-tests.ps1 -Subnet <x.y.z.0/24>   # disposable DB + Dredd
powershell -NoProfile -File contract-test/evidence-gate.test.ps1   # the run's evidence gate, no Docker
```

`-Subnet` is required (a subnet outside 192.168.0.0/16 for the run's internal network). The run
stages its logs and publishes them into `-Evidence` only after the live-data guard passed for
every capture, redacted (`contract-test/evidence-gate.ps1`).

The legacy purge (`DELETE /workbench/sources/:id { confirm: true, reason_type, note? }`) is the
contract's D5 suppress: `reason_type` (a key of the `erasure_reasons` registry) is required, it
records a `suppressed` trail event, re-scores the source's claims, and `POST
/workbench/sources/:id/restore` reverses it until a gated erase.

The integration test (`src/contracts/integration_test.ts`) runs only against the disposable
database `contract-test/run-contract-tests.ps1` creates; it suppresses, severs and erases rows.

## References as first-class records (research-workbench P2a)

A reference is held once, in `reference_records` (`../init-references.sql`, initdb slot 240;
revert: `../revert-references.sql`, before P0's revert): the source pointer, anchor selectors
(text quote with prefix/suffix, text position, and page+quad for the content types the
`reference_selector_kinds` registry names), provenance (`user | assistant`), the pinned revision
and chunk, and a state. Notes and user documents hold its id (`reference_holders`), never a copy.
A database trigger refuses any reference without a quote, so the rule holds for every writer.

- `GET /workbench/contract/references/{id}` answers a reference record (kind `reference`, read at
  its pin) as well as a source; `POST .../references` places one, pinned at the source's current
  revision; `GET .../holders/{kind}/references?ref=` lists a holder's references by id, body-less.
- `POST .../diff-check` takes reference ids, a holder, or P0's bare pins; it returns ids,
  revisions and states only - the re-anchoring (`strpos` over the current chunks) runs inside the
  database and no chunk text crosses the wire.
- Legacy notes (`notes/`): `note-refs` and `export` read the records. The migration is
  `deno run --allow-net --allow-env --allow-read src/contracts/migrate-references.ts [--dry-run]`
  inside the container after the SQL; a note whose references the legacy reader listed
  differently is refused (exit 1) and nothing is written for it. After the migration the
  frontmatter `sources:` list is no longer read; added references live in the record.

```
powershell -NoProfile -File contract-test/run-references-tests.ps1 -Subnet <x.y.z.0/24>   # disposable P2a run (same -Subnet / evidence gate as P0)
```

## Export with resolved references (research-workbench P6a)

`GET /workbench/export?path=<vault .md>&format=<key>&style=<key>[&wrap=none][&mode=copy]` renders a page with its
numbered references through pandoc 3.11 `--citeproc` and a CSL style; a PDF is typeset by Typst
0.15.1 (main face Noto Serif CJK SC, so CJK text renders). `GET /workbench/export/about` is the
attribution: the CSL project (https://citationstyles.org/), every style with its authors, pandoc's
GPL source offer.

- **Registries, not lists** (`init-export.sql`): `export_formats` (pdf, docx, md, txt - each entry
  carries pandoc's output format, the PDF engine and the page), `citation_styles` (ieee - the default,
  numbered - elsevier-vancouver, apa; each the upstream CSL file in `csl/`, unmodified, with its
  sha256 and author listing) and `reference_identifier_kinds` (doi, arxiv, pubmed, pmc, openalex:
  the pattern, the URL rules, the OpenAlex/Crossref templates). A new format, style or identifier
  kind is a row (plus its `.csl` file); no code switches on a key.
- **Resolution**: each numbered reference's source identifier (declared metadata, then its URL) is
  resolved once through the keyed OpenAlex API, Crossref's polite pool as the fallback, through the
  egress proxy (`src/export/resolver.ts`), and the CSL-JSON is cached on the reference record at its
  pinned revision (`reference_resolutions`), so later exports are deterministic offline. A source
  without an identifier is cited as the page it is. Shipped inert: no key and no mailto, no resolver.
- **Hard failure**: a dead identifier, the resolver off, a malformed identifier, a citation of a
  source that does not exist or is suppressed - the export answers 422 naming every such reference;
  nothing is rendered as text. Good resolutions of a refused export stay cached (a retry asks only
  for what failed). **Copy page** (`mode=copy`, plain text) is not an export: it never calls the
  resolver and prints an unresolved reference marked `UNRESOLVED (<reason>)` (no suppressed title).
- **The resolver's door** (`send()`): only the configured OpenAlex/Crossref origins, the key on every
  OpenAlex request and the mailto on every Crossref one, checked before sending; redirects are never
  followed (a 3xx fails the reference); a record carrying the key, the mailto or a URL with a query
  is refused; a transport failure shows a reason code (`egress: network error|timeout`), and its
  detail goes to the workbench log with the secrets masked.
- **What a note cannot do**: its title prints literally (`@`, `#set`, `$x$`, a backslash are text),
  a stray `@` never becomes a citation, raw HTML / raw TeX / `{=format}` blocks are not passed
  through (dropped from the MD, DOCX and PDF), a `javascript:` or `data:` link keeps only its text.
  A style is hashed when it is USED (a modified or missing file, or one that is a symlink or lies
  outside the style directory, answers 503 `style-integrity`); a character no installed face covers
  refuses the PDF before Typst runs (422 `glyphs`; emoji render with Noto Color Emoji).
- **The note is parsed, not pattern-matched** (rw-p6a-resolve attempt 3, `src/export/markdown.ts`):
  micromark (MIT) parses the body into a syntax tree; links, images and references with a target
  other than http(s)/mailto/relative lose the target, raw HTML and every attribute block go, text is
  written back escaped, an unsafe-scheme string in text reads `javascript[:]`. The glyph check reads
  the parsed text (code, fences, math, alt text, titles, references). The parse runs in a worker pool
  (`src/export/prepare_worker.ts`, `EXPORT_PARSE_WORKERS`, `EXPORT_PARSE_TIMEOUT_MS` 15 s).
- **Limits before pandoc** (422 `too-complex`, naming the limit): the note's size
  (`EXPORT_MAX_NOTE_BYTES`, 1 MB), bracket nesting (32), tree depth (64), list depth (16),
  emphasis delimiters and brackets per paragraph (1000 each), the parser's time; pandoc runs with
  `+RTS -N1 -M2g`, a CPU limit (prlimit) and a wall clock (`EXPORT_PANDOC_TIMEOUT_MS`, 60 s) after
  which it is killed with its children.
- **Every output is verified before it is served** (`src/export/verify.ts`, `pdf_read.ts`): the MD
  re-parsed (no unsafe target, raw node, attribute block, fenced div with attributes, raw TeX), the
  DOCX unzipped (external relationships and HYPERLINK fields http(s)/mailto, no fetching field), the
  PDF parsed (URI actions http(s)/mailto, no other action, no .notdef box drawn), and every format's
  text searched for unsafe-scheme strings and the configured key or mailto (tags stripped,
  invisible characters removed): 503 `output-verification` or `credential`, never a 200. Only the
  writers this verifies (pdf through Typst, docx, markdown, plain) can be registered formats
  (503 `format` otherwise).
- **The credential check's cost is bounded per process** (rw-p6a-followups, `src/export/judge_pool.ts`):
  every text an output's check judges (the MD and TXT included) is judged in a worker, never on the
  request thread; one export's check runs at a time (`VERIFY_SLOTS` 1) over one pool of at most
  `VERIFY_WORKERS` (min(8, cores - 1)) workers, and an export waits for its turn without spending its
  15 s budget (`verification-busy` 503 after `VERIFY_WAIT_MS`, 300 s). Peak memory of one 400 KB note's
  check: +1.17 GB for the DOCX, +1.02 GB for the PDF; concurrent exports of it peak at about the same.
  A 422 reference field that could not be judged is withheld as "could not be judged", not as carrying
  the credential. The runtime image carries no `*_test.ts` and no test oracle (`credentials_oracle.ts`);
  the test stage runs them and the build gates on it.
- **D9**: pandoc runs as a separate process over files (markdown, a JSON metadata file, a CSL-JSON
  bibliography file and the verified style in, the document out), Typst as its child; no Lua/JSON filter, no AST round trip. The citekey grammar and
  CSL clean-up are ported from manubot 859dd15 (BSD-2-Clause-Patent), not run. WeasyPrint, the
  former PDF engine, is gone from the runtime image; it lives only in the image's `parity` stage,
  which renders the parity fixture through both engines (`src/export/parity_fixture.ts`).

```
powershell -NoProfile -File contract-test/run-export-tests.ps1 [-Subnet a.b.c.0/24]   # disposable P6a run (stub APIs)
```
