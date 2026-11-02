// deno test --allow-net --allow-env --allow-read src/intake/intake_test.ts - rw-p5a-intake, pure parts (the
// image test gate runs this directory): the queues' state machines (one primary action each; retry and
// cancel exactly where they work), the declared content types, the research service's intake fetch client
// (inert until configured; a fixed code, never the other service's words) and the identity seam's OWUI
// inlet rule (only Open WebUI's service key may act for a user, on the add only).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import { actionsOf, INTAKE_KINDS, validId } from "./repo.ts";
import { fileContentType, INTAKE_CONTENT_TYPES, isIntakeContentType } from "./content_types.ts";
import { IntakeFetchError, researchIntakeFetch } from "./research_fetch.ts";
import { originOf } from "./routes.ts";
import { identityOf, identitySeam, onBehalfSubject, seamDeps } from "../middleware/identity.ts";

Deno.test("every queue's every state has exactly one primary action; retry and cancel only where they work", () => {
  const states: Record<string, string[]> = {
    import: ["queued", "extracting", "embedding", "linking", "done", "failed", "cancelled"],
    add: ["queued", "fetching", "extracting", "holding", "held", "failed", "cancelled"],
    chunk: ["pending", "failed", "cancelled"],
    extract: ["pending", "processing", "failed", "cancelled", "skipped"],
    entity: ["pending", "processing", "failed", "cancelled", "skipped"],
  };
  assertEquals(Object.keys(states), [...INTAKE_KINDS]);
  for (const [kind, list] of Object.entries(states)) {
    for (const st of list) {
      const a = actionsOf(kind as never, st);
      assert(["retry", "cancel", "open", "wait"].includes(a.primary), `${kind}/${st}`);
      if (a.primary === "retry" || a.primary === "cancel") assert(a.actions.includes(a.primary), `${kind}/${st}: the primary is offered`);
      const failed = st === "failed" || st === "cancelled" || st === "skipped";
      assertEquals(a.actions.includes("retry"), failed, `${kind}/${st}: retry iff it failed or was cancelled`);
    }
  }
  assertEquals(actionsOf("add", "queued").primary, "cancel");
  assertEquals(actionsOf("add", "fetching").primary, "cancel");
  assertEquals(actionsOf("add", "holding").actions, []); // the hold is one transaction: it finishes or fails
  assertEquals(actionsOf("add", "held").primary, "open");
  assertEquals(actionsOf("chunk", "pending").primary, "cancel");
  assertEquals(actionsOf("extract", "processing").actions, []);
});

Deno.test("job ids: a uuid for import / add / chunk / extract, a thought's number for entity", () => {
  assert(validId("add", "99999999-9999-4999-8999-99999999999a"));
  assert(!validId("add", "1234"));
  assert(validId("entity", "1234"));
  assert(!validId("entity", "99999999-9999-4999-8999-99999999999a"));
});

Deno.test("the declared content types: web page, PDF and YouTube transcript - and a file is a PDF or a saved page", async () => {
  assertEquals([...INTAKE_CONTENT_TYPES], ["web_article", "pdf", "youtube_transcript"]);
  assert(isIntakeContentType("pdf") && !isIntakeContentType("docx"));
  const enc = (s: string) => new TextEncoder().encode(s);
  assertEquals(fileContentType("paper.pdf", enc("%PDF-1.7\n...")), "pdf");
  assertEquals(fileContentType("weird-name", enc("%PDF-1.4")), "pdf");
  assertEquals(fileContentType("page.html", enc("<!doctype html><html></html>")), "web_article");
  assertEquals(fileContentType("notes.docx", enc("PK\x03\x04")), null);
  assertEquals(fileContentType("page.txt", enc("<html>")), null);
  // the research service declares the same three (a local run reads its file; the image has no sibling tree)
  const rs = new URL("../../../../integrations/research-service/intake-fetch.ts", import.meta.url);
  const src = await Deno.readTextFile(rs).catch(() => "");
  if (src) assert(src.includes(`export const INTAKE_CONTENT_TYPES = ["web_article", "pdf", "youtube_transcript"] as const;`));
});

Deno.test("the research intake fetch: inert until RESEARCH_URL and RESEARCH_WORKSPACE_KEY are set", () => {
  assertEquals(researchIntakeFetch((k) => ({ RESEARCH_URL: "http://r" } as Record<string, string>)[k]), null);
  assertEquals(researchIntakeFetch((k) => ({ RESEARCH_WORKSPACE_KEY: "k" } as Record<string, string>)[k]), null);
});

Deno.test("the research intake fetch: one POST /intake/fetch with the workspace key; refusal codes kept, anything else fixed", async () => {
  const seen: { path: string; key: string | null; body: unknown }[] = [];
  let answer: () => Response = () => Response.json({ ok: true, content_type: "web_article", title: "T", text: "body", final_url: "https://e.org/a", redirects: [], egress: "proxy" });
  const ac = new AbortController();
  const srv = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (req) => {
    seen.push({ path: new URL(req.url).pathname, key: req.headers.get("x-brain-key"), body: await req.json() });
    return answer();
  });
  const base = `http://127.0.0.1:${(srv.addr as Deno.NetAddr).port}`;
  try {
    const f = researchIntakeFetch((k) => ({ RESEARCH_URL: base, RESEARCH_WORKSPACE_KEY: "ws-key" } as Record<string, string>)[k])!;
    const ok = await f("https://e.org/a", "web_article");
    assertEquals([ok.title, ok.text, ok.egress], ["T", "body", "proxy"]);
    assertEquals(seen[0], { path: "/intake/fetch", key: "ws-key", body: { url: "https://e.org/a", content_type: "web_article" } });
    answer = () => Response.json({ error: "no_transcript", detail: "the video has none" }, { status: 422 });
    const e1 = await f("https://youtu.be/dQw4w9WgXcQ", null).catch((e) => e);
    assert(e1 instanceof IntakeFetchError && e1.code === "no_transcript" && e1.httpStatus === 422);
    answer = () => Response.json({ error: "SECRET /var/lib/x password=hunter2" }, { status: 500 });
    const e2 = await f("https://e.org/b", null).catch((e) => e);
    assert(e2 instanceof IntakeFetchError && e2.code === "upstream_error");
    assert(!JSON.stringify({ m: e2.message, s: e2.stack }).includes("hunter2"));
  } finally {
    ac.abort();
    await srv.finished;
  }
});

// ── the OWUI inlet in the identity seam ───────────────────────────────────────────────────────
const OWUI_KEY = "owui-service-key-0123456789";
const OTHER_KEY = "other-service-key-0123456789";
function seamApp() {
  const env = (k: string) => ({
    WORKBENCH_KEY: "door-and-internal-key-0123456789", WORKSPACE_SERVICE_KEYS: `owui=${OWUI_KEY};digest=${OTHER_KEY}`,
  } as Record<string, string>)[k];
  const app = new Hono();
  app.use("/workbench/*", identitySeam(seamDeps(null, env)));
  app.all("/workbench/*", async (c) => {
    const w = await identityOf(c);
    return c.json({ sub: w.sub, actor: w.actor, kind: w.kind, origin: originOf(w) });
  });
  return app;
}
const call = (path: string, key: string, obo?: string, method = "POST") =>
  seamApp().request(`http://wb${path}`, { method, headers: { "x-brain-key": key, ...(obo !== undefined ? { "x-on-behalf-of": obo } : {}) } });

Deno.test("the OWUI inlet: Open WebUI's service key acts for the named user on the intake add, origin owui", async () => {
  const r = await call("/workbench/intake/add", OWUI_KEY, "authentik-sub-of-user-a");
  assertEquals(r.status, 200);
  assertEquals(await r.json(), { sub: "authentik-sub-of-user-a", actor: "service:owui", kind: "on-behalf", origin: "owui" });
  const j = await call("/workbench/intake/jobs/add/99999999-9999-4999-8999-99999999999a", OWUI_KEY, "authentik-sub-of-user-a", "GET");
  assertEquals(j.status, 200);
  // without the header the key is the service itself (it owns no user's adds)
  assertEquals((await (await call("/workbench/intake/add", OWUI_KEY)).json()).sub, "service:owui");
});

Deno.test("the OWUI inlet: any other key, any other route, or an unusable subject is refused", async () => {
  assertEquals((await call("/workbench/intake/add", OTHER_KEY, "user-a")).status, 403); // another service
  assertEquals((await call("/workbench/intake/add", "door-and-internal-key-0123456789", "user-a")).status, 403); // a browser's door
  assertEquals((await call("/workbench/intake/jobs", OWUI_KEY, "user-a", "GET")).status, 403); // not the add
  assertEquals((await call("/workbench/documents", OWUI_KEY, "user-a", "GET")).status, 403);
  assertEquals((await call("/workbench/intake/jobs/add/99999999-9999-4999-8999-99999999999a/cancel", OWUI_KEY, "user-a")).status, 403);
  for (const bad of ["", "service:internal", "system:x", "anonymous:", "a\tb", "x".repeat(300)]) {
    assertEquals((await call("/workbench/intake/add", OWUI_KEY, bad)).status, 400, JSON.stringify(bad));
  }
  assertEquals(onBehalfSubject(" user-a "), "user-a");
  // a browser's own add is origin workspace
  const w = await (await call("/workbench/intake/add", "door-and-internal-key-0123456789")).json();
  assertEquals(w.origin, "workspace");
});

Deno.test("the intake's own files make no fetch of a user's link but the research client's one call", async () => {
  for (const f of ["routes.ts", "pipeline.ts", "repo.ts", "content_types.ts", "research_fetch.ts"]) {
    const src = (await Deno.readTextFile(new URL(`./${f}`, import.meta.url))).split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    assert(!/FETCH_PROXY_URL|createHttpClient|openbrain-mcp|redirect:\s*["']follow/.test(src), `${f}: no proxy, mcp or followed redirect`);
    const sites = (src.match(/(?<![.\w])fetch\(/g) ?? []).length;
    assertEquals(sites, f === "research_fetch.ts" ? 1 : 0, `${f}: fetch( sites`);
  }
  const rf = await Deno.readTextFile(new URL("./research_fetch.ts", import.meta.url));
  assert(rf.includes("${base}/intake/fetch") && rf.includes('"x-brain-key": key'));
});

// round 3 (reviewer R2): a restart orphans every in-flight import and add (the pipelines are fire-and-forget in
// the process); at start they are marked failed - with a fixed reason, retryable from the panel - never left holding
Deno.test("round 3: at start, stale in-flight imports and adds (holding, embedding, ...) are marked failed and retryable", async () => {
  const { sweepStaleJobs, STALE_REASON } = await import("./repo.ts");
  const seen: { sql: string; args: unknown[] }[] = [];
  const db = {
    query: (sql: string, args: unknown[] = []) => { seen.push({ sql, args }); return Promise.resolve([{ id: "a" }, { id: "b" }]); },
    tx: (f: (d: unknown) => unknown) => f(db),
  };
  assertEquals(await sweepStaleJobs(db as never), 2);
  assertEquals(seen.length, 1);
  const states = seen[0].args.find(Array.isArray) as string[];
  for (const st of ["holding", "embedding", "fetching", "extracting", "linking", "queued"]) assert(states.includes(st), `sweeps ${st}`);
  for (const st of ["done", "held", "failed", "cancelled"]) assert(!states.includes(st), `leaves ${st}`);
  assert(/SET status = 'failed'/.test(seen[0].sql) && seen[0].args.includes(STALE_REASON));
  assert(actionsOf("import", "failed").actions.includes("retry"));
  const main = await Deno.readTextFile(new URL("../main.ts", import.meta.url));
  assert(/sweepStaleJobs\(/.test(main), "main.ts runs the sweep at start");
  // round 4 (reviewer N4): awaited, and before the listener starts
  const sweepAt = main.search(/await sweepStaleJobs\(/), serveAt = main.search(/Deno\.serve\(/);
  assert(sweepAt >= 0 && serveAt > sweepAt, "main.ts awaits the sweep before Deno.serve");
});
