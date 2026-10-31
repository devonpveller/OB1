// The app itself (every router, every middleware), importable without serving: main.ts serves it;
// the lab isolation sweep (src/documents/isolation_sweep_test.ts) enumerates its routes from here.
// openbrain-workbench — the browser-facing read/write API behind the Quartz
// viewer (D-A). Deno + Hono, internal PORT=8000, reached same-origin via the
// portal Caddy `handle /workbench/* { reverse_proxy openbrain-workbench:8000 }`
// (prefix-PRESERVING — §2.3), which injects the shared secret as X-Brain-Key.
//
// Architecture (G9): Hono SUB-ROUTERS per resource over a thin
// service → repository layering. Routes are PREFIX-INCLUSIVE (mounted under
// /workbench) to match the prefix-preserving `handle` proxy. DB writes go
// through withTransaction (repository, G8); reads may use PostgREST.
//
// Kept OFF the MCP server + cloud-gateway (8-tool contract) so the
// multipart/upload/auth surface stays isolated (plan §2.1).
//
// Routers land per phase:
//   /workbench/health      — P0 (this skeleton)
//   /workbench/notebooks   — P2
//   /workbench/notes       — P3
//   /workbench/sources     — P4
//   /workbench/import      — P5  (+ /workbench/jobs)
//   /workbench/grounding   — P6
//   /workbench/contract/*  — research-workbench P0: the typed retrieval contract
//                            (src/contracts/; GET /openapi.json is its document)
//   /workbench/documents   — research-workbench P2b: user documents (D12) - the documents tree,
//                            the listing record, references, the refinery from the document
//   /workbench/workspace   — research-workbench P2b: the title bar bell's acknowledgement
//   /workbench/exports     — research-workbench P6b: the caller's own gated export runs (the export panel)
//   /workbench/auth        — rw-identity: who am I, admin impersonation and its audit log (sign-in
//                            is Authentik forward-auth at the edge; inert without WORKSPACE_FORWARD_AUTH_*)
import { Hono } from "hono";
import { requireKey } from "./middleware/auth.ts";
import { identitySeam, seamDeps } from "./middleware/identity.ts";
import { authRouter } from "./routes/auth.ts";
import { ownerScope } from "./middleware/owner-scope.ts";
import { health } from "./routes/health.ts";
import { notebooks } from "./routes/notebooks.ts";
import { notes } from "./routes/notes.ts";
import { sources, sourceCommit } from "./routes/sources.ts";
import { imports, jobs } from "./routes/import.ts";
import { grounding } from "./routes/grounding.ts";
import { exporter } from "./routes/export.ts";
import { exportsRouter } from "./routes/exports.ts";
import { runStore } from "./export/runs.ts";
import { identityOf } from "./middleware/identity.ts";
import { noteRefs } from "./routes/note-refs.ts";
import { noteHistory, noteCommit } from "./routes/note-history.ts";
import { search } from "./routes/search.ts";
import { graph } from "./routes/graph.ts";
import { nav } from "./routes/nav.ts";
import { documentsRouter, workspaceRouter } from "./routes/documents.ts";
import { ideaScheduleRouter } from "./routes/idea-schedule.ts";
import { refetchClient, researchClient } from "./documents/clients.ts";
import { createContractApp, openApiDocument } from "./contracts/app.ts";
import { contractDeps } from "./contracts/wiring.ts";

// deno-postgres returns BIGINT columns (e.g. entities.id, thoughts.id) as JS
// BigInt, which JSON.stringify cannot serialize → every response carrying one
// would 500. Make BigInt serialize as a number globally (all our ids are well
// under 2^53). One line, app-wide.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

export const app = new Hono();

// Health is unauthenticated (Docker healthcheck + overlay connectivity proof).
// Exposed both at the bare path (internal healthcheck) and the prefix-inclusive
// path (what the browser reaches through Caddy).
app.route("/health", health);
app.route("/workbench/health", health);

// The retrieval contract's OpenAPI document. Bare path unauthenticated like /health (internal
// only: the service is never host-published except the loopback debug port); the
// prefix-inclusive path is what Caddy forwards, behind the key gate below.
const cdeps = contractDeps();
const contract = createContractApp(cdeps);
// research-workbench P2b: the documents API shares the contract's database seam and registry reader.
export const docDeps = { db: cdeps.db, reg: cdeps.registry, embed: cdeps.embed, chunk: cdeps.chunk, research: researchClient(), refetch: refetchClient() };
const contractDoc = openApiDocument(contract);
app.get("/openapi.json", (c) => c.json(contractDoc));

// rw-identity: which keys open the door, and the sign-in (both from the environment; a half-configured
// sign-in, or one without its own door key, refuses to start - src/identity/forward_auth.ts, keys.ts)
export const seam = seamDeps(cdeps.db);

// Everything else requires the door-injected secret (G7). The gate is
// registered before the resource routers so it runs first in the chain.
app.use("/workbench/*", requireKey(seam.ring));
// research-workbench P2b: the identity seam - the ONE place that resolves who the request's user is
// (src/middleware/identity.ts); user front-end state is read and written for that identity only.
// rw-identity2: with forward-auth configured the identity is the request's verified Authentik token (a
// browser without a valid one gets 401 bar /workbench/auth/me and health), and an admin's
// impersonating requests are audited before they run.
app.use("/workbench/*", identitySeam(seam));
// round 2 (tester attempt 1 F1-F6): the owner scope - every request naming a documents/ path must be
// the caller's own, and every JSON response is walked for another user's document or refinery id
// (src/middleware/owner-scope.ts). Before every router, so no route can skip it.
app.use("/workbench/*", ownerScope(cdeps.db));

// Resource sub-routers (prefix-inclusive). Added per phase.
app.route("/workbench/notebooks", notebooks); // P2
app.route("/workbench/notes", notes); // P3
app.route("/workbench/sources", sources); // P4
app.route("/workbench/source-commit", sourceCommit); // P4.7 — compile-time revision commit
app.route("/workbench/import", imports); // P5 (single upload route; P6 grounding too)
app.route("/workbench/jobs", jobs); // P5
app.route("/workbench/grounding", grounding); // P6
app.route("/workbench/export", exporter); // P3.5 — pandoc note export
app.route("/workbench/exports", exportsRouter(runStore(cdeps.db), identityOf)); // research-workbench P6b — the caller's own gated export runs
app.route("/workbench/note-refs", noteRefs); // P3.5 — note reference list
app.route("/workbench/note-history", noteHistory); // P4.7 — note git revisions
app.route("/workbench/note-commit", noteCommit); // P4.7 — commit-now / compile-catch
app.route("/workbench/search", search); // wiki-dynamic-index P3 — DB-backed wiki search
app.route("/workbench/graph", graph); // wiki-dynamic-index — page-scoped graph neighbourhood
app.route("/workbench/nav", nav); // research-workbench P1b — the explorer, one folder at a time (forwards to the viewer)
app.route("/workbench/documents", documentsRouter(docDeps)); // research-workbench P2b — user documents (D12)
app.route("/workbench/workspace", workspaceRouter(cdeps.db)); // research-workbench P2b — the bell's acknowledgement
app.route("/workbench/idea-schedule", ideaScheduleRouter(cdeps.db)); // rw-idea-schedule - when research on my ideas starts; research now
app.route("/workbench/auth", authRouter({ // rw-identity — who am I, impersonation, the audit log
  db: cdeps.db, fa: seam.fa, mode: seam.fa ? "forward-auth" : seam.cfg.header ? "header" : "default",
}));
app.get("/workbench/openapi.json", (c) => c.json(contractDoc)); // research-workbench P0
app.route("/", contract); // research-workbench P0 — /workbench/contract/* (paths are absolute)

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error("[workbench] error:", err?.message || err);
  return c.json({ error: "internal", detail: String(err?.message || err) }, 500);
});

