// deno test src/export/export_test.ts - the P6a export WITHOUT a database and without running
// pandoc: the registries, the identifier grammar, the CSL mapping, the resolver's egress and key
// rules and its hard failure, the pandoc input, the process-separation shape of the call, and the
// CSL styles shipped unmodified. Runs in the image's test gate (and on a host with Deno).
import { assert, assertEquals, assertMatch, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { crossrefToCsl, dateToDateParts, MetadataIncomplete, openalexToCsl, recordToCsl } from "./csl.ts";
import { identifierFromUrl, IdentifierError, type IdentifierKind, parseCitekey, sourceIdentifier } from "./identifiers.ts";
import { createResolver, RequestRefused, ResolutionFailed, type ResolverConfig } from "./resolver.ts";
import { citeKey, fatalWarnings, type FormatDef, INPUT_FORMAT, pandocArgs, prepareDocument, UnnumberedCitation } from "./render.ts";
import { FX_ENTRIES, fxEntries } from "./registry_fixtures.ts";
import { aboutExport } from "./about.ts";
import { fixtureId } from "./test_fixtures.ts";

const root = new URL("../../", import.meta.url); // the workbench directory
const KINDS: IdentifierKind[] = fxEntries("reference_identifier_kinds").map((e) => ({ key: e.key, ...e.definition }) as IdentifierKind);
const kind = (k: string) => KINDS.find((x) => x.key === k)!;
const PDF = { key: "pdf", ...fxEntries("export_formats").find((e) => e.key === "pdf")!.definition } as FormatDef;
const MD = { key: "md", ...fxEntries("export_formats").find((e) => e.key === "md")!.definition } as FormatDef;

// ── the registries ──────────────────────────────────────────────────────────────────────────
function sqlEntries(sql: string) {
  // ('registry', 'key', 'label', '{json}') tuples of the INSERT ... contract_registry_entries
  const out: { registry: string; key: string; label: string; definition: unknown }[] = [];
  const body = sql.split("INSERT INTO public.contract_registry_entries")[1]?.split("ON CONFLICT")[0] ?? "";
  const re = /\(\s*'([a-z_]+)',\s*'([a-z0-9._-]+)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\s*\)/g;
  for (const m of body.matchAll(re)) {
    out.push({ registry: m[1], key: m[2], label: m[3].replaceAll("''", "'"), definition: JSON.parse(m[4].replaceAll("''", "'")) });
  }
  return out;
}

Deno.test("the gate's registry entries are exactly the rows init-export.sql seeds (when the migration is reachable)", async () => {
  let sql: string;
  try {
    sql = await Deno.readTextFile(new URL("../init-export.sql", root));
  } catch {
    return; // inside the image the migrations are not in the build context
  }
  const rows = sqlEntries(sql);
  assertEquals(rows.length, FX_ENTRIES.length, "entry count");
  for (const r of rows) {
    const fx = FX_ENTRIES.find((e) => e.registry === r.registry && e.key === r.key);
    assert(fx, `${r.registry}/${r.key} is not in registry_fixtures.ts`);
    assertEquals([fx.label, fx.definition], [r.label, r.definition], `${r.registry}/${r.key}`);
  }
  for (const reg of ["export_formats", "citation_styles", "reference_identifier_kinds"]) {
    assert(sql.includes(`('${reg}',`), `registry ${reg} is declared`);
  }
});

Deno.test("formats and styles are registry entries, not a closed list in the renderer or the route", async () => {
  const route = await Deno.readTextFile(new URL("src/routes/export.ts", root));
  const exporter = await Deno.readTextFile(new URL("src/export/exporter.ts", root));
  const render = await Deno.readTextFile(new URL("src/export/render.ts", root));
  for (const [name, src] of [["routes/export.ts", route], ["export/exporter.ts", exporter], ["export/render.ts", render]]) {
    const code = src.replace(/\/\/.*$/gm, "");
    for (const key of ["pdf", "docx", "md", "txt", "ieee", "apa", "elsevier-vancouver", "typst", "weasyprint"]) {
      assert(!new RegExp(`["'\`]${key}["'\`]`).test(code), `${name} names the registry key '${key}' in code`);
    }
    assert(!/\bswitch\s*\(/.test(code), `${name} switches on something`);
  }
  assert(exporter.includes('live("export_formats")') && exporter.includes('live("citation_styles")'));
  assertEquals(fxEntries("citation_styles").filter((e) => e.definition.default === true).length, 1, "exactly one default style");
});

// ── identifiers (manubot 859dd15 citekey grammar) ────────────────────────────────────────────
Deno.test("citekeys: prefixes are case-insensitive aliases of a standard prefix; DOIs lower-cased; bad accessions fail", () => {
  assertEquals(parseCitekey(KINDS, "DOI:10.5555/P6A.ABC").citekey, "doi:10.5555/p6a.abc");
  assertEquals(parseCitekey(KINDS, "pmid:12345").citekey, "pubmed:12345");
  assertEquals(parseCitekey(KINDS, "pmcid:PMC123").citekey, "pmc:PMC123");
  assertEquals(parseCitekey(KINDS, "arxiv:2101.00001v2").citekey, "arxiv:2101.00001v2");
  assertEquals(parseCitekey(KINDS, "openalex:W2741809807").citekey, "openalex:W2741809807");
  assertThrows(() => parseCitekey(KINDS, "doi:11.5555/x"), IdentifierError, "not a valid doi");
  assertThrows(() => parseCitekey(KINDS, "pmid:0123"), IdentifierError);
  assertThrows(() => parseCitekey(KINDS, "isbn:9780000000000"), IdentifierError, "not a known identifier prefix");
  assertThrows(() => parseCitekey(KINDS, "10.5555/x"), IdentifierError, "no identifier prefix");
});

Deno.test("identifiers in source URLs (manubot url_to_citekey): doi.org, arXiv abs/pdf, PubMed, PMC, OpenAlex; anything else none", () => {
  const u = (s: string) => identifierFromUrl(KINDS, s)?.citekey ?? null;
  assertEquals(u("https://doi.org/10.5555/P6A.001"), "doi:10.5555/p6a.001");
  assertEquals(u("https://dx.doi.org/10.5555%2Fp6a.002"), "doi:10.5555/p6a.002");
  assertEquals(u("https://arxiv.org/abs/2101.00001v3"), "arxiv:2101.00001v3");
  assertEquals(u("https://arxiv.org/pdf/2101.00001.pdf"), "arxiv:2101.00001");
  assertEquals(u("https://pubmed.ncbi.nlm.nih.gov/31452104/"), "pubmed:31452104");
  assertEquals(u("https://pmc.ncbi.nlm.nih.gov/articles/PMC6460000/"), "pmc:PMC6460000");
  assertEquals(u("https://openalex.org/W2741809807"), "openalex:W2741809807");
  assertEquals(u("https://example.org/10.5555/p6a.001"), null, "a DOI-shaped path on another host is not the source's identifier");
  assertEquals(u("not a url"), null);
  assertEquals(u(null as unknown as string), null);
});

Deno.test("a source's own identifier: declared metadata first (incl. P3a's scholarly.doi), then the URL; a malformed declaration fails", () => {
  const id = (url: string | null, metadata: Record<string, unknown> | null) => sourceIdentifier(KINDS, { url, metadata })?.citekey ?? null;
  assertEquals(id("https://doi.org/10.5555/a", { doi: "10.5555/B" }), "doi:10.5555/b");
  assertEquals(id(null, { scholarly: { doi: "https://doi.org/10.5555/C" } }), "doi:10.5555/c");
  assertEquals(id(null, { pmid: "123" }), "pubmed:123");
  assertEquals(id("https://doi.org/10.5555/d", {}), "doi:10.5555/d");
  assertEquals(id("https://example.org/post", { linked: ["10.5555/e"] }), null, "a linked DOI is never the source's own");
  assertThrows(() => id(null, { doi: "not-a-doi" }), IdentifierError);
});

// rw-p6a-resolve attempt 2, ADV-2c (near-miss 3): the tester's identifier strings, every one of
// which matched manubot's `10\.[0-9]{4,9}/\S+` and was sent. Each is refused BEFORE any request,
// declared (metadata) or recognised in a URL, with the reference named by the route (422).
const HOSTILE_DOIS = [
  "10.5555/adv.inj@evil.stub", "10.5555/../../../x", "10.5555/adv?api_key=stolen&x=http://evil.stub/",
  "10.5555/adv.001,10.5555/adv.002", "10.5555/adv.001;10.5555/adv.002", "10.5555/adv.injü€中", `10.5555/${"a".repeat(2048)}`,
  "10.5555/adv#http://evil.stub/", "10.5555/%2F..%2Fevil", "10.5555/a b", "10.5555/a\tb", "10.5555/x//y",
  "http://evil.stub/10.5555/adv.inj", "10.5555/adv:http://evil.stub/",
];
Deno.test("ADV-2c: identifiers outside their kind's grammar are refused - @, .., a query, a second id, non-ASCII, >256 chars, a URL, whitespace", () => {
  for (const d of HOSTILE_DOIS) {
    assertThrows(() => parseCitekey(KINDS, `doi:${d}`), IdentifierError, undefined, `declared ${d.slice(0, 60)}`);
    assertThrows(() => sourceIdentifier(KINDS, { url: null, metadata: { doi: d } }), IdentifierError, undefined, `metadata ${d.slice(0, 60)}`);
  }
  // a doi.org URL claims a DOI: one that fails the grammar is malformed, not silently a web page
  assertThrows(() => sourceIdentifier(KINDS, { url: "https://doi.org/10.5555/adv.inj@evil.stub", metadata: {} }), IdentifierError);
  assertThrows(() => parseCitekey(KINDS, `pmid:1 2`), IdentifierError);
  assertThrows(() => parseCitekey(KINDS, `arxiv:2101.00001/../x`), IdentifierError);
  // attempt 3 (the tester's near-miss 3): no kind admits `<`, `>`, `"`, `'` or a backtick, so a
  // SICI-style DOI with angle brackets is refused, named - and so is a `<script>`-shaped one
  for (const bad of ["10.1002/(SICI)1097-4679(199711)53:7<657::AID-JCLP3>3.0.CO;2-F", "10.5555/adv.id<script>alert(1);</script>", '10.5555/a"b', "10.5555/a'b", "10.5555/a`b"]) {
    assertThrows(() => parseCitekey(KINDS, `doi:${bad}`), IdentifierError, "is not a valid doi identifier", bad);
  }
  assertThrows(() => parseCitekey(KINDS, "pmid:1<2"), IdentifierError);
  // ... whatever a kind's registry pattern admits: the guard is in accessionOk, not in each row
  const loose = { key: "loose", prefixes: ["loose"], pattern: ".+" } as IdentifierKind;
  for (const bad of ["a<b", "a>b", 'a"b', "a'b", "a`b"]) assertThrows(() => parseCitekey([loose], `loose:${bad}`), IdentifierError, undefined, `loose ${bad}`);
  assertEquals(parseCitekey([loose], "loose:a-b").accession, "a-b");
  // what real DOIs look like still passes: SICI without angle brackets (;:()), dots, dashes, underscores, slashes
  for (const ok of ["10.1002/(SICI)1097-4679(199711)53:7;2-F", "10.1000/xyz.abc-1_2/3", "10.48550/arxiv.2101.00001"]) {
    assertEquals(parseCitekey(KINDS, `doi:${ok}`).accession, ok.toLowerCase());
  }
});

Deno.test("near-miss 7: declared-metadata identifier keys come from the identifier-kind rows (metadata_keys), not a list in code", () => {
  const advk: IdentifierKind = { key: "advk", prefixes: ["advk"], pattern: "ADV[0-9]{3}", metadata_keys: ["advk", "ids.advk"], openalex_work: "advk:{accession}" } as IdentifierKind;
  const kinds = [...KINDS, advk];
  assertEquals(sourceIdentifier(kinds, { url: null, metadata: { advk: "ADV005" } })?.citekey, "advk:ADV005");
  assertEquals(sourceIdentifier(kinds, { url: null, metadata: { ids: { advk: "ADV006" } } })?.citekey, "advk:ADV006", "a dotted key reads a nested field");
  // the row is the authority: a doi row without metadata_keys does not read metadata.doi
  const noKeys = KINDS.map((k) => k.key === "doi" ? { ...k, metadata_keys: [] } : k);
  assertEquals(sourceIdentifier(noKeys, { url: null, metadata: { doi: "10.5555/b" } }), null);
  // a declared value written as a URL is read through the kind's own URL rules
  assertEquals(sourceIdentifier(KINDS, { url: null, metadata: { doi: "https://doi.org/10.5555/B" } })?.citekey, "doi:10.5555/b");
  assertEquals(sourceIdentifier(KINDS, { url: null, metadata: { openalex: "https://openalex.org/W123" } })?.citekey, "openalex:W123");
  for (const k of KINDS) assert(Array.isArray((k as { metadata_keys?: unknown }).metadata_keys), `${k.key}: the row declares its metadata_keys`);
});

// ── CSL items ─────────────────────────────────────────────────────────────────────────────────
Deno.test("Crossref -> CSL: manubot's type mapping, date parts, given/family names, the DOI lower-cased", () => {
  const c = crossrefToCsl({
    type: "journal-article", title: ["A Title"], author: [{ given: "Ann", family: "Author" }, { name: "A Consortium" }],
    "container-title": ["J. Tests"], volume: "3", issue: "2", page: "1-10", issued: { "date-parts": [[2020, 5]] },
    DOI: "10.5555/ABC", "reference-count": 12, "is-referenced-by-count": 4,
  });
  assertEquals(c.type, "article-journal");
  assertEquals(c.author, [{ family: "Author", given: "Ann" }, { literal: "A Consortium" }]);
  assertEquals(c.issued, { "date-parts": [[2020, 5]] });
  assertEquals([c.DOI, c.URL], ["10.5555/abc", "https://doi.org/10.5555/abc"]);
  assert(!("reference-count" in c) && !("is-referenced-by-count" in c), "nothing outside the CSL variables");
  assertEquals(crossrefToCsl({ type: "proceedings-article", title: "T" }).type, "paper-conference");
  assertThrows(() => crossrefToCsl({ type: "journal-article" }), MetadataIncomplete);
});

Deno.test("OpenAlex -> CSL: display names kept whole, page range, container, publication date", () => {
  const c = openalexToCsl({
    id: "https://openalex.org/W1", doi: "https://doi.org/10.5555/X", title: "OA title", type: "article",
    publication_date: "2019-03-04", authorships: [{ author: { display_name: "Ann Q. Author" } }],
    primary_location: { source: { display_name: "Journal of OA", host_organization_name: "OA Press" } },
    biblio: { volume: "7", issue: "1", first_page: "10", last_page: "19" }, cited_by_count: 3,
  });
  assertEquals(c, {
    type: "article-journal", title: "OA title", author: [{ literal: "Ann Q. Author" }], "container-title": "Journal of OA",
    volume: "7", issue: "1", page: "10-19", publisher: "OA Press", issued: { "date-parts": [[2019, 3, 4]] },
    DOI: "10.5555/x", URL: "https://doi.org/10.5555/x",
  });
  assertEquals(dateToDateParts("2020"), [2020]);
  assertEquals(dateToDateParts("garbage"), null);
  assertEquals(recordToCsl({ title: "A page\n title", url: "https://example.org/p", accessed: "2026-10-01" }),
    { type: "webpage", title: "A page title", URL: "https://example.org/p", accessed: { "date-parts": [[2026, 10, 1]] } });
});

// ── the resolver: inert, egress, keys, hard failure ──────────────────────────────────────────
interface Call { url: string; headers: Record<string, string>; client: unknown }
function net(responses: Record<string, [number, unknown]>) {
  const calls: Call[] = [];
  const fetch = (url: string, init: RequestInit & { client?: Deno.HttpClient }) => {
    calls.push({ url, headers: init.headers as Record<string, string>, client: init.client });
    const hit = Object.entries(responses).find(([k]) => url.includes(k));
    const [status, body] = hit ? hit[1] : [404, { error: "not found" }];
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { calls, fetch };
}
const CLIENT = { close() {} } as unknown as Deno.HttpClient;
const cfg = (o: Partial<ResolverConfig> = {}): ResolverConfig => ({
  openalexKey: "oa-test-key", mailto: "p6a@example.invalid", proxyUrl: "http://proxy.invalid:8888",
  openalexBase: "http://api.openalex.stub", crossrefBase: "http://api.crossref.stub", timeoutMs: 2000, ...o,
});
const DOI1 = parseCitekey(KINDS, "doi:10.5555/p6a.001");
const OA_WORK = { title: "OA one", type: "article", doi: "https://doi.org/10.5555/p6a.001", publication_date: "2020-01-01" };
const CR_MSG = { message: { title: ["CR one"], type: "journal-article", DOI: "10.5555/p6a.001" } };

Deno.test("SHIPPED INERT: no key and no mailto -> the resolver is off, nothing is built or requested, resolve fails loudly", async () => {
  const n = net({});
  let built = 0;
  const r = createResolver(cfg({ openalexKey: "", mailto: "" }), { fetch: n.fetch, buildClient: () => (built++, CLIENT) });
  assertEquals(r.status.state, "off");
  await assertRejects(() => r.resolve(DOI1, kind("doi")), ResolutionFailed, "shipped inert");
  assertEquals([n.calls.length, built], [0, 0]);
});

Deno.test("FAIL-CLOSED egress: a blank FETCH_PROXY_URL or a proxy client that cannot be built refuses the resolver - never direct", async () => {
  const n = net({ "/works/": [200, OA_WORK] });
  const blank = createResolver(cfg({ proxyUrl: "" }), { fetch: n.fetch, buildClient: () => CLIENT });
  assertEquals(blank.status.state, "refused");
  await assertRejects(() => blank.resolve(DOI1, kind("doi")), ResolutionFailed, "never goes direct");
  const broken = createResolver(cfg(), { fetch: n.fetch, buildClient: () => { throw new Error("bad proxy url"); } });
  assertEquals(broken.status.state, "refused");
  await assertRejects(() => broken.send("openalex", "http://api.openalex.stub/works/x?api_key=oa-test-key"), RequestRefused);
  assertEquals(n.calls.length, 0);
});

Deno.test("acceptance 3 RED->GREEN at the door: a request without the key / the mailto is refused BEFORE it leaves", async () => {
  const n = net({ "/works/": [200, OA_WORK] });
  const r = createResolver(cfg(), { fetch: n.fetch, buildClient: () => CLIENT });
  // RED: what a non-compliant client would send
  await assertRejects(() => r.send("openalex", "http://api.openalex.stub/works/doi%3A10.5555%2Fx"), RequestRefused, "must carry the API key");
  await assertRejects(() => r.send("openalex", "http://api.openalex.stub/works/x?api_key=other"), RequestRefused, "must carry the API key");
  await assertRejects(() => r.send("crossref", "http://api.crossref.stub/works/10.5555%2Fx"), RequestRefused, "polite-pool mailto");
  await assertRejects(() => r.send("crossref", "http://elsewhere.stub/works/x?mailto=p6a@example.invalid"), RequestRefused, "not to the configured Crossref API");
  assertEquals(n.calls.length, 0, "nothing left");
  // GREEN: the resolver's own requests carry both, through the proxy client
  await r.resolve(DOI1, kind("doi"));
  const oa = new URL(n.calls[0].url);
  assertEquals([oa.searchParams.get("api_key"), oa.searchParams.get("mailto"), n.calls[0].client], ["oa-test-key", "p6a@example.invalid", CLIENT]);
});

Deno.test("OpenAlex first (keyed), Crossref polite pool as the fallback, both through the proxy client", async () => {
  const n = net({ "api.openalex.stub": [404, { error: "no" }], "api.crossref.stub": [200, CR_MSG] });
  const r = createResolver(cfg(), { fetch: n.fetch, buildClient: () => CLIENT });
  const res = await r.resolve(DOI1, kind("doi"));
  assertEquals([res.via, res.csl.title], ["crossref", "CR one"]);
  assertEquals(n.calls.length, 2);
  assertEquals(decodeURIComponent(new URL(n.calls[0].url).pathname), "/works/doi:10.5555/p6a.001");
  const cr = new URL(n.calls[1].url);
  assertEquals([decodeURIComponent(cr.pathname), cr.searchParams.get("mailto")], ["/works/10.5555/p6a.001", "p6a@example.invalid"]);
  assertMatch(n.calls[1].headers["user-agent"], /mailto:p6a@example\.invalid/);
  assert(n.calls.every((c) => c.client === CLIENT), "every request carries the proxy client");
});

Deno.test("acceptance 2 at the resolver: a dead identifier is a HARD failure naming what each service said", async () => {
  const n = net({ "api.openalex.stub": [404, {}], "api.crossref.stub": [404, {}] });
  const r = createResolver(cfg(), { fetch: n.fetch, buildClient: () => CLIENT });
  const e = await assertRejects(() => r.resolve(DOI1, kind("doi")), ResolutionFailed);
  assertMatch(e.message, /OpenAlex answered 404 for doi:10\.5555\/p6a\.001; Crossref answered 404 for 10\.5555\/p6a\.001/);
  const five = createResolver(cfg(), { fetch: net({ "api.openalex.stub": [500, {}], "api.crossref.stub": [503, {}] }).fetch, buildClient: () => CLIENT });
  await assertRejects(() => five.resolve(DOI1, kind("doi")), ResolutionFailed, "Crossref answered 503");
  const torn = createResolver(cfg(), { fetch: () => Promise.reject(new Error("connection reset")), buildClient: () => CLIENT, log: () => {} });
  await assertRejects(() => torn.resolve(DOI1, kind("doi")), ResolutionFailed, "OpenAlex request failed (egress: network error)");
  // the failure text reaches the export's 422 body: a fetch error that quotes its URL is NOT quoted
  // (attempt 2: a reason code only); the server log gets it with the query cut and both secrets masked
  const logged: string[] = [];
  const leaky = createResolver(cfg(), {
    fetch: (url: string) => Promise.reject(new TypeError(`error sending request for url (${url}): connection refused`)), buildClient: () => CLIENT,
    log: (m: string) => logged.push(m),
  });
  const e2 = await assertRejects(() => leaky.resolve(DOI1, kind("doi")), ResolutionFailed, "Crossref request failed (egress: network error)");
  assert(!e2.message.includes("oa-test-key") && !e2.message.includes("p6a@example.invalid") && !e2.message.includes("p6a%40example.invalid"), e2.message);
  assert(!/connection refused|stub/.test(e2.message), e2.message);
  assert(logged.some((l) => /\[query removed\]/.test(l) && l.includes("connection refused")), logged.join("\n"));
  assert(logged.every((l) => !l.includes("oa-test-key") && !l.includes("p6a@example.invalid") && !l.includes("p6a%40example.invalid")), logged.join("\n"));
  const empty = createResolver(cfg({ mailto: "" }), { fetch: net({ "api.openalex.stub": [200, { type: "article" }] }).fetch, buildClient: () => CLIENT });
  await assertRejects(() => empty.resolve(DOI1, kind("doi")), ResolutionFailed, "OpenAlex returned a record without a title");
});

Deno.test("one service configured: the other is never called, and the failure says why", async () => {
  const n1 = net({ "api.openalex.stub": [404, {}] });
  const keyOnly = createResolver(cfg({ mailto: "" }), { fetch: n1.fetch, buildClient: () => CLIENT });
  await assertRejects(() => keyOnly.resolve(DOI1, kind("doi")), ResolutionFailed, "Crossref not tried: CROSSREF_MAILTO is not configured");
  assert(n1.calls.every((c) => c.url.includes("api.openalex.stub")));
  const n2 = net({ "api.crossref.stub": [200, CR_MSG] });
  const mailOnly = createResolver(cfg({ openalexKey: "" }), { fetch: n2.fetch, buildClient: () => CLIENT });
  assertEquals((await mailOnly.resolve(DOI1, kind("doi"))).via, "crossref");
  assert(n2.calls.every((c) => c.url.includes("api.crossref.stub")), "OpenAlex is never called unkeyed");
  const n3 = net({ "api.openalex.stub": [404, {}] });
  const arx = createResolver(cfg(), { fetch: n3.fetch, buildClient: () => CLIENT });
  await assertRejects(() => arx.resolve(parseCitekey(KINDS, "arxiv:2101.00001"), kind("arxiv")), ResolutionFailed, "Crossref cannot resolve a arxiv identifier");
  assertEquals(decodeURIComponent(new URL(n3.calls[0].url).pathname), "/works/doi:10.48550/arxiv.2101.00001");
});

// ── the pandoc input ──────────────────────────────────────────────────────────────────────────
Deno.test("the pandoc input: source wikilinks cite their reference keys, other wikilinks degrade, stray @ cannot become citations", () => {
  const [a, b, c] = [fixtureId(1), fixtureId(2), fixtureId(3)];
  const refs = [1, 2, 3].map((n) => ({ key: citeKey(fixtureId(n)), number: n, csl: { type: "entry", title: `T${n}` } }));
  const md = `---\ntitle: "My note"\nbibliography: /etc/passwd\nsources: [${c}]\n---\n# H\n\nSee [[content/source/${a}|S1]], [[source/${b}]] and [[content/source/${a}|again]].\n` +
    "Mail me@example.org or @handle, [@cite], -@x.\n\n`code @inline` and <https://x.org/@u> and [l](https://m.org/@u).\n\n```\n@fenced\n```\n\n[[tool-x]] [[a/b|Y]]\n";
  const p = prepareDocument(md, refs, MD);
  assert(p.markdown.includes(`See S1 [@src-${a}], [@src-${b}] and again [@src-${a}].`));
  // attempt 3: the text is written back from the parsed tree with every `@` escaped (no user text can
  // become a citation) and every `[` (no user text can become a link)
  assert(p.markdown.includes("Mail me\\@example.org or \\@handle, \\[\\@cite], -\\@x."), p.markdown);
  assert(p.markdown.includes("`code @inline` and <https://x.org/@u> and [l](https://m.org/@u)."));
  assert(p.markdown.includes("```\n@fenced\n```"));
  assert(p.markdown.includes("tool-x Y"));
  assert(!p.markdown.includes("bibliography") && !p.markdown.startsWith("---"), "the note's frontmatter is not handed to pandoc");
  assertEquals(p.cited, [`src-${a}`, `src-${b}`]);
  assertEquals(p.nocite, [`src-${c}`], "the added reference is nocited");
  assertEquals(p.metadata.nocite, `@src-${c}`);
  assertEquals(p.metadata.title, "My note");
  assertEquals(p.references.map((r) => r.id), refs.map((r) => r.key), "the references are the CSL-JSON bibliography, in number order");
  assert(!("references" in p.metadata), "not in the metadata (pandoc would read their strings as markdown)");
  assert(!("bibliography" in p.metadata) && !("csl" in p.metadata));
  // a link the numbering does not know (not a uuid) is refused, never rendered as text
  assertThrows(() => prepareDocument("x [[source/1111111111111111111111111111111111-1|bad]]", [], MD), UnnumberedCitation, "not a citable source id");
});

// ── acceptance 5: separate process, files in and out, no filter, no AST ──────────────────────
Deno.test("acceptance 5: pandoc is called with files (markdown + metadata in, document out); no filter, no JSON AST", () => {
  const style = { key: "ieee", ...fxEntries("citation_styles")[0].definition } as never;
  const args = pandocArgs("/tmp/ob-export-x", { md: "", refs: [], format: PDF, style, cslDir: "/app/csl", wrapNone: true });
  assertEquals(args.slice(-3), ["--output", "/tmp/ob-export-x/out.pdf", "/tmp/ob-export-x/in.md"]);
  for (const want of ["--citeproc", "--csl", "/tmp/ob-export-x/ieee.csl", "--bibliography", "/tmp/ob-export-x/references.json", "--metadata-file", "/tmp/ob-export-x/meta.json", "--pdf-engine", "typst"]) {
    assert(args.includes(want), `missing ${want}`);
  }
  const joined = args.join(" ").replaceAll("meta.json", "META").replaceAll("references.json", "BIB");
  assertEquals(args[args.indexOf("--from") + 1], INPUT_FORMAT);
  for (const off of ["yaml_metadata_block", "pandoc_title_block", "raw_html", "raw_attribute", "raw_tex", "link_attributes", "header_attributes", "inline_code_attributes", "fenced_code_attributes", "bracketed_spans", "fenced_divs"]) {
    assert(INPUT_FORMAT.split("-").includes(off), `the input reads ${off} as text (off)`);
  }
  assert(!/--(lua-)?filter|(^| )-[FL]\b|\bjson\b|native/.test(joined), joined);
});

Deno.test("acceptance 5: no source file drives pandoc through a filter or a JSON AST, and no pandoc library is imported", async () => {
  const offenders: string[] = [];
  for await (const f of walk(new URL("src/", root))) {
    if (f.pathname.endsWith("_test.ts")) continue;
    const code = (await Deno.readTextFile(f)).replace(/\/\/.*$/gm, "");
    // pandoc's filter options (--filter / -F, --lua-filter / -L), a JSON AST (to or from json), a
    // pandoc library or WASM build imported
    if (/lua-filter|--filter\b|"-F"|"-L"|--(to|from|read|write)[= ]"?json\b|"json"\s*\]/.test(code) || /from\s+["'][^"']*pandoc/i.test(code)) {
      offenders.push(f.pathname);
    }
  }
  assertEquals(offenders, []);
  const cfgText = await Deno.readTextFile(new URL("deno.json", root));
  const lock = await Deno.readTextFile(new URL("deno.lock", root));
  assert(!/pandoc|citeproc/i.test(cfgText) && !/pandoc|citeproc/i.test(lock), "a pandoc/citeproc package is a dependency");
});

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* walk(u);
    else if (e.name.endsWith(".ts")) yield u;
  }
}

Deno.test("an unresolved citation or a missing font in pandoc's report is fatal (the real pandoc 3.11 / Typst wording)", () => {
  assertEquals(fatalWarnings("[WARNING] Citeproc: citation nope not found\n"), ["Citeproc: citation nope not found"]);
  assertEquals(fatalWarnings("warning: unknown font family: no such font\n   ┌─ x.typ"), ["unknown font family: no such font"]);
  assertEquals(fatalWarnings("[WARNING] Could not fetch resource x.png\n"), []);
});

// ── acceptance 7: the CSL styles, unmodified, attributed ─────────────────────────────────────
async function sha256(b: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const names = (info: string, tag: string) => [...info.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))]
  .map((m) => /<name>([\s\S]*?)<\/name>/.exec(m[1])![1].trim().replaceAll("&apos;", "'"));

Deno.test("acceptance 7: every registered CSL style is the upstream file byte for byte, with its author listing intact", async () => {
  const files = [...Deno.readDirSync(new URL("csl/", root))].map((e) => e.name).filter((n) => n.endsWith(".csl")).sort();
  const styles = fxEntries("citation_styles");
  assertEquals(files, styles.map((s) => s.definition.file as string).sort(), "every shipped style is registered, and only those");
  for (const s of styles) {
    const bytes = await Deno.readFile(new URL(`csl/${s.definition.file}`, root));
    assertEquals(await sha256(bytes), s.definition.sha256, `${s.key}: the file is not the upstream file it was fetched as (modified?)`);
    const info = /<info>([\s\S]*?)<\/info>/.exec(new TextDecoder().decode(bytes))![1];
    assertEquals(names(info, "author"), s.definition.authors, `${s.key}: author listing`);
    assertEquals(names(info, "contributor"), s.definition.contributors, `${s.key}: contributor listing`);
    assertMatch(info, /<rights license="http:\/\/creativecommons\.org\/licenses\/by-sa\/3\.0\/">/);
  }
});

Deno.test("acceptance 7: the export's about text mentions the CSL project with its link, every style's authors, and pandoc's source offer", () => {
  const about = aboutExport(fxEntries("citation_styles"), fxEntries("export_formats"), (k) => ({ EXPORT_PANDOC_VERSION: "3.11", EXPORT_TYPST_VERSION: "0.15.1" })[k]);
  assertMatch(about.text, /Citation Style Language \(CSL\) project \(https:\/\/citationstyles\.org\/\)/);
  assertEquals(about.styles.map((s) => s.key), ["ieee", "elsevier-vancouver", "apa"]);
  assertEquals(about.styles[0].authors, ["Michael Berkowitz"]);
  const pandoc = about.programs.find((p) => p.name === "pandoc")!;
  assertEquals([pandoc.version, pandoc.licence], ["3.11", "GPL-2.0-or-later"]);
  assertMatch(pandoc.source_offer!, /complete corresponding source[\s\S]*refs\/tags\/3\.11\.tar\.gz[\s\S]*three years/);
});
