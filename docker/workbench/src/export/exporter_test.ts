// deno test --allow-all src/export/exporter_test.ts - the export ROUTE (exporter.ts) driven in the
// build gate with fakes for the database and the network (rw-p6a-resolve attempt 2, the tester's
// near-misses 1, 2, 4, 9 and the 500s of ADV-5a). The renders go through the real pandoc + Typst
// (the image's test stage).
//   near-miss 1  a dead DOI answers 422 naming the reference, and nothing is rendered - caught HERE,
//                at build, if the refusal is reverted (attempt 1: only the disposable runner caught it)
//   near-miss 2  decision B: a refused export keeps the good resolutions cached; the retry asks only
//                for the dead one
//   near-miss 4  a transport failure's 422 carries a reason code + "egress", never an address or host
//   near-miss 9  decision C: "Copy page" (mode=copy) with the resolver inert answers 200, every
//                unresolved reference marked UNRESOLVED, no request made; the export still refuses
//   ADV-5a/4b    a render failure is a coded 422/503, never a 500 with pandoc's text
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createExporter, type ExporterDeps } from "./exporter.ts";
import { createResolver, type ResolverConfig } from "./resolver.ts";
import { fxEntries } from "./registry_fixtures.ts";
import type { ExportRef } from "./repo.ts";
import { RenderFailed } from "./render.ts";
import type { CslItem } from "./csl.ts";
import { fixtureId } from "./test_fixtures.ts";

const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
const KEY = "ex-test-key-0001";
const MAILTO = "ex-test@example.invalid";
const cfg = (o: Partial<ResolverConfig> = {}): ResolverConfig => ({
  openalexKey: KEY, mailto: MAILTO, proxyUrl: "http://proxy.invalid:8888",
  openalexBase: "http://api.openalex.stub", crossrefBase: "http://api.crossref.stub", timeoutMs: 2000, ...o,
});
const CLIENT = { close() {} } as unknown as Deno.HttpClient;

// The fake world: sources by number (DOI 10.5555/p6a.NNN unless said otherwise), the reference cache.
interface Src { n: number; doi?: string; url?: string; title?: string; suppressed?: boolean; missing?: boolean }
function world(sources: Src[], fetchImpl?: (url: string) => Promise<Response>) {
  const calls: string[] = [];
  const cache = new Map<string, { identifier: string; csl: CslItem; via: string }[]>();
  const renders: unknown[] = [];
  const logs: string[] = [];
  const fetch = (url: string) => {
    calls.push(url);
    if (fetchImpl) return fetchImpl(url);
    const m = /p6a\.(\d{3}|dead)/.exec(decodeURIComponent(url));
    const n = m?.[1];
    if (!n || n === "dead") return Promise.resolve(Response.json({ error: "no" }, { status: 404 }));
    return Promise.resolve(Response.json(url.includes("openalex")
      ? { title: `Resolved ${Number(n)}`, type: "article", doi: `https://doi.org/10.5555/p6a.${n}`, publication_date: "2021-01-01" }
      : { message: { title: [`Resolved ${Number(n)}`], type: "journal-article", DOI: `10.5555/p6a.${n}` } }));
  };
  const refs = (): ExportRef[] => sources.map((s, i) => ({
    number: i + 1, cited_ref: fixtureId(s.n), reference_id: `ref-${s.n}`, pinned_revision: 1,
    source_id: s.missing ? null : fixtureId(s.n), suppressed: !!s.suppressed,
    title: s.title ?? `Record title ${s.n}`, url: s.url ?? `https://doi.org/${s.doi ?? `10.5555/p6a.${String(s.n).padStart(3, "0")}`}`,
    metadata: {}, accessed: "2026-10-01", cached: cache.get(`ref-${s.n}`) ?? [],
  }));
  const deps = (o: Partial<ExporterDeps> & { resolverCfg?: Partial<ResolverConfig> } = {}): ExporterDeps => ({
    reg: { entries: (r: string) => Promise.resolve(fxEntries(r)) },
    resolver: createResolver(cfg(o.resolverCfg), { fetch, buildClient: () => CLIENT, log: (m) => logs.push(m) }),
    cslDir: CSL_DIR, vaultDir: "/nonexistent-vault",
    readNote: (rel: string) => Promise.resolve(rel === "notes/t/n.md" ? note(sources) : rel === "notes/t/title.md" ? TITLE_NOTE : null),
    loadRefs: () => Promise.resolve(refs()),
    cache: (rid, identifier, csl, via) => {
      cache.set(rid, [...(cache.get(rid) ?? []), { identifier, csl, via }]);
      return Promise.resolve();
    },
    log: (m) => logs.push(m),
    ...o,
  });
  return { calls, cache, renders, logs, deps };
}
const note = (sources: Src[]) => `---\ntitle: "Route note"\n---\n# Route\n\n${sources.map((s) => `Claim [[source/${fixtureId(s.n)}|c${s.n}]].`).join("\n\n")}\n`;
const TITLE_NOTE = `---\ntitle: 'Title mail @me and [@you] #set $x$'\n---\n# T\n\nNo references here.\n`;
const get = (deps: ExporterDeps, q: string) => createExporter(deps).request(`/?${q}`);
const spyRender = (seen: unknown[]) => (i: unknown) => (seen.push(i), Promise.reject(new Error("render must not be called")));

Deno.test("near-miss 1 (R1 at build): a dead DOI answers 422 naming the reference, and nothing is rendered", async () => {
  const w = world([{ n: 1 }, { n: 101, doi: "10.5555/p6a.dead", title: "Record dead" }, { n: 2 }]);
  const r = await get(w.deps({ render: spyRender(w.renders) as never }), "path=notes/t/n.md&format=pdf");
  assertEquals(r.status, 422);
  const b = await r.json();
  assertEquals(b.error, "export refused: 1 of 3 references could not be resolved");
  assertEquals(b.references.length, 1);
  const [u] = b.references;
  assertEquals([u.number, u.source_id, u.identifier, u.title], [2, fixtureId(101), "doi:10.5555/p6a.dead", "Record dead"]);
  assertMatch(u.reason, /OpenAlex answered 404 for doi:10\.5555\/p6a\.dead; Crossref answered 404 for 10\.5555\/p6a\.dead/);
  assertEquals(w.renders.length, 0, "nothing rendered for a refused export");
  for (const f of ["docx", "md", "txt"]) assertEquals((await get(w.deps({ render: spyRender(w.renders) as never }), `path=notes/t/n.md&format=${f}`)).status, 422, f);
});

Deno.test("near-miss 2, decision B: a refused export keeps the good resolutions cached; the retry asks only for the dead one", async () => {
  const w = world([{ n: 1 }, { n: 101, doi: "10.5555/p6a.dead" }, { n: 2 }]);
  const d = w.deps({ render: spyRender(w.renders) as never });
  assertEquals((await get(d, "path=notes/t/n.md&format=md")).status, 422);
  assertEquals([...w.cache.keys()].sort(), ["ref-1", "ref-2"], "the two good resolutions are cached, the dead one is not");
  assertEquals(w.calls.length, 4, "OpenAlex x3 (two hits, one miss) + Crossref x1 for the dead DOI");
  const before = w.calls.length;
  assertEquals((await get(d, "path=notes/t/n.md&format=md")).status, 422);
  assertEquals(w.calls.slice(before).map((u) => decodeURIComponent(new URL(u).pathname)), ["/works/doi:10.5555/p6a.dead", "/works/10.5555/p6a.dead"], "the retry requests only the dead reference");
});

Deno.test("near-miss 4: a transport failure's 422 names a reason code + 'egress' and no internal address or host", async () => {
  const w = world([{ n: 7 }], (u) => Promise.reject(new TypeError(`error sending request from 10.249.78.9:58734 for ${u} (10.249.78.2:5432): client error (SendRequest): connection closed before message completed`)));
  const r = await get(w.deps({ render: spyRender(w.renders) as never }), "path=notes/t/n.md&format=pdf");
  assertEquals(r.status, 422);
  const body = await r.text();
  assert(!/\d+\.\d+\.\d+\.\d+|5432|SendRequest|api_key|proxy\.invalid|\.stub/.test(body), body);
  assertMatch(body, /OpenAlex request failed \(egress: network error\); Crossref request failed \(egress: network error\)/);
  assert(w.logs.some((l) => l.includes("connection closed before message completed")) && w.logs.every((l) => !l.includes(KEY) && !l.includes(MAILTO)), "detail in the server log, masked");
});

Deno.test("near-miss 9, decision C: Copy page (mode=copy) with the resolver INERT answers 200 with every unresolved reference marked; the export still refuses", async () => {
  const sources: Src[] = [{ n: 1 }, { n: 102, url: "https://example.org/web", title: "A web page" }, { n: 103, suppressed: true, title: "Hidden suppressed title" }, { n: 104, missing: true }];
  const w = world(sources);
  const inert = w.deps({ resolverCfg: { openalexKey: "", mailto: "" } });
  assertEquals(inert.resolver.status.state, "off");
  const r = await get(inert, "path=notes/t/n.md&mode=copy");
  assertEquals(r.status, 200);
  assertEquals([r.headers.get("content-type"), r.headers.get("content-disposition"), r.headers.get("x-export-mode"), r.headers.get("x-export-unresolved")],
    ["text/plain; charset=utf-8", "inline", "copy", "3"]);
  const t = (await r.text()).replace(/\s+/g, " ");
  assertMatch(t, /\[1\] [“"]?UNRESOLVED \(not resolved yet\): Record title 1/);
  assertMatch(t, /\[2\] [“"]?A web page/, "a web page needs no resolution: rendered as itself");
  assertMatch(t, /\[3\] [“"]?UNRESOLVED \(suppressed source\)/);
  assert(!t.includes("Hidden suppressed title"), "a suppressed source's title is never printed");
  assertMatch(t, /\[4\] [“"]?UNRESOLVED \(the cited source does not exist\)/);
  assertEquals(w.calls.length, 0, "the copy view never asks the resolver");
  // a resolver that is ON: the copy view still never requests (no egress from a clipboard copy)
  const on = w.deps();
  assertEquals((await get(on, "path=notes/t/n.md&mode=copy")).status, 200);
  assertEquals(w.calls.length, 0);
  // the export (no mode) keeps acceptance 1's rule
  assertEquals((await get(inert, "path=notes/t/n.md&format=txt&wrap=none")).status, 422);
  assertEquals((await get(inert, "path=notes/t/n.md&mode=copy&format=pdf")).status, 400, "copy is plain text only (definition.copy)");
  assertEquals((await get(inert, "path=notes/t/n.md&mode=bogus")).status, 400);
});

Deno.test("ADV-5a / ADV-4b at the route: a render failure is a coded 422 or 503, never a 500, and pandoc's report stays in the server log", async () => {
  const cases: [RenderFailed, number][] = [
    [new RenderFailed("the document could not be converted (pandoc failed; the workbench log has its report)", "pandoc: SECRET-DETAIL /tmp/ob-export-x", "pandoc"), 422],
    [new RenderFailed("the export would print a citation it holds no reference for", "Citeproc: citation me not found", "citation"), 422],
    [new RenderFailed("the PDF cannot be typeset: no installed font covers U+10600", "", "glyphs", { characters: ["U+10600"] }), 422],
    [new RenderFailed("the PDF cannot be typeset: a font the format names is not installed (X)", "unknown font family: X", "font", { fonts: ["X"] }), 503],
    [new RenderFailed("citation style 'ieee' failed its integrity check: modified", "modified", "style-integrity", { style: "ieee" }), 503],
  ];
  for (const [err, status] of cases) {
    const w = world([{ n: 1 }]);
    const r = await get(w.deps({ render: () => Promise.reject(err) }), "path=notes/t/n.md&format=pdf");
    assertEquals(r.status, status, err.code);
    const b = await r.json();
    assertEquals([b.code, b.error], [err.code, err.message]);
    assert(!JSON.stringify(b).includes("SECRET-DETAIL") && !JSON.stringify(b).includes("/tmp/"), JSON.stringify(b));
    if (err.detail) assert(w.logs.some((l) => l.includes(err.detail)), "the detail is in the server log");
  }
});

Deno.test("ADV-5a + ADV-4b through the real renderer: the @me title note exports (200); a one-byte-modified style answers 503 naming it", async () => {
  const w = world([]);
  for (const f of ["pdf", "docx", "md", "txt"]) assertEquals((await get(w.deps(), `path=notes/t/title.md&format=${f}`)).status, 200, f);
  const dir = await Deno.makeTempDir({ prefix: "ob-csl-route-" });
  try {
    for (const e of Deno.readDirSync(CSL_DIR)) await Deno.copyFile(`${CSL_DIR}/${e.name}`, `${dir}/${e.name}`);
    const ieee = await Deno.readTextFile(`${dir}/ieee.csl`);
    await Deno.writeTextFile(`${dir}/ieee.csl`, ieee.replace("<title>IEEE", "<title>JEEE"));
    const r = await get(w.deps({ cslDir: dir }), "path=notes/t/title.md&format=pdf");
    assertEquals(r.status, 503);
    const b = await r.json();
    assertEquals([b.code, b.style], ["style-integrity", "ieee"]);
    assertMatch(b.error, /citation style 'ieee' failed its integrity check/);
    assertEquals((await get(w.deps({ cslDir: dir }), "path=notes/t/title.md&format=pdf&style=apa")).status, 200, "an unmodified style still renders");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── rw-p6a-resolve attempt 3 at the route ──────────────────────────────────────────────────────────
const splitTitle = (tag: string) => `Split ${KEY.slice(0, 6)}${tag}${KEY.slice(6)} and ${MAILTO.slice(0, 5)}${tag}${MAILTO.slice(5)}`;
const EMPTY_TAGS = ["<i></i>", "<b></b>", "<sc></sc>", '<span class="nocase"></span>'];

Deno.test("A3 / ADV-3 at the route: a 200 record whose title holds the key and the mailto split by each empty citeproc tag is refused 422, named, and never cached", async () => {
  for (const tag of EMPTY_TAGS) {
    const w = world([{ n: 1 }], (url) => Promise.resolve(url.includes("openalex")
      ? Response.json({ title: splitTitle(tag), type: "article", doi: "https://doi.org/10.5555/p6a.001" })
      : Response.json({ error: "no" }, { status: 404 })));
    const r = await get(w.deps({ render: spyRender(w.renders) as never }), "path=notes/t/n.md&format=pdf");
    assertEquals(r.status, 422, tag);
    const body = await r.text();
    assertMatch(body, /OpenAlex returned a record carrying credential-shaped text \(refused\)/, tag);
    assert(!body.includes(KEY) && !body.includes(MAILTO), `${tag}: the body carries neither secret`);
    assertEquals(w.cache.size, 0, `${tag}: nothing cached`);
    assertEquals(w.renders.length, 0, `${tag}: nothing rendered`);
  }
});

Deno.test("A3 / ADV-3 at the route: a CACHED row holding a split key (cached before attempt 3) is refused for the export and marked for the Copy page - no secret in either", async () => {
  for (const tag of EMPTY_TAGS) {
    const w = world([{ n: 1 }]);
    w.cache.set("ref-1", [{ identifier: "doi:10.5555/p6a.001", csl: { type: "article", title: splitTitle(tag) } as CslItem, via: "openalex" }]);
    const r = await get(w.deps(), "path=notes/t/n.md&format=md");
    assertEquals(r.status, 422, tag);
    const b = await r.text();
    assertMatch(b, /the cached record carries credential-shaped text/);
    assert(!b.includes(KEY) && !b.includes(MAILTO), tag);
    const c = await get(w.deps(), "path=notes/t/n.md&mode=copy");
    assertEquals(c.status, 200, tag);
    const t = await c.text();
    assertMatch(t, /UNRESOLVED \(unsafe cached record\)/);
    assert(!t.includes(KEY) && !t.includes(MAILTO) && !t.replace(/\s+/g, "").includes(KEY), `${tag}: the Copy page carries neither secret`);
  }
});

Deno.test("A3 (near-miss 2): the download 422 names a suppressed source by its number and 'suppressed' only - no title, no id", async () => {
  const w = world([{ n: 1 }, { n: 103, suppressed: true, title: "SUPPRESSED-TITLE-LEAK secret record" }]);
  const r = await get(w.deps({ render: spyRender(w.renders) as never }), "path=notes/t/n.md&format=pdf");
  assertEquals(r.status, 422);
  const b = await r.json();
  const text = JSON.stringify(b);
  assert(!text.includes("SUPPRESSED-TITLE-LEAK") && !text.includes(fixtureId(103)), text);
  assertEquals(b.references, [{ number: 2, cited_ref: null, source_id: null, title: null, identifier: null, reason: "suppressed" }]);
});

Deno.test("A3 at the route: a failed output verification, a credential in the output and a format the export cannot verify are 503, a limit 422 - never a 200 or a 500", async () => {
  const cases: [RenderFailed, number][] = [
    [new RenderFailed("the pdf export was not served: its output verification found a URI action to 'javascript:x'", "javascript:x", "output-verification", { format: "pdf", offence: "a URI action" }), 503],
    [new RenderFailed("the md export was not served: it would carry the configured service credential (the text holds ex...16 characters)", "", "credential", { format: "md" }), 503],
    [new RenderFailed("the export format 'html' uses a writer the export cannot verify ('html5')", "", "format", { format: "html" }), 503],
    [new RenderFailed("the document is too complex to export: the bracket nesting depth is 33, the limit is 32", "", "too-complex", { limit: "the bracket nesting depth", value: 33, max: 32 }), 422],
  ];
  for (const [err, status] of cases) {
    const w = world([{ n: 1 }]);
    const r = await get(w.deps({ render: () => Promise.reject(err) }), "path=notes/t/n.md&format=pdf");
    assertEquals(r.status, status, err.code);
    assertEquals((await r.json()).code, err.code);
  }
  // and through the real renderer: the route passes the resolver's secrets to the output check - a note
  // whose own text holds the configured key answers 503 credential
  const w = world([]);
  const deps = w.deps({ readNote: (rel: string) => Promise.resolve(rel === "notes/t/k.md" ? `# K\n\nMy key ${KEY.slice(0, 4)}<b></b>${KEY.slice(4)} here.\n` : null) });
  const r = await get(deps, "path=notes/t/k.md&format=txt");
  assertEquals(r.status, 503);
  const b = await r.json();
  assertEquals(b.code, "credential");
  assert(!JSON.stringify(b).includes(KEY));
});
