/**
 * Scholarly metadata through the keyed OpenAlex client with Crossref fallback, via the egress
 * proxy (research-workbench P3a, D15 item 1). Offline: the "network" is fixtures/scholarly/
 * responses.json, served by a stub fetch that records whether every call carried the proxy client.
 * Run: deno test --allow-read scholarly.test.ts
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cleanDoi, createScholarlyResolver, headDoi, linkedDois, ownIdentifier, proxiedFetch, type ProxiedFetch,
  safeReasonText, safeScholarlyRecord, SCHOLARLY_REASON_PATTERN, scholarlyReasonAllowed,
} from "./scholarly.ts";
import { fixtureNetwork, fixtureResolver, PROXY_CLIENT } from "./fixtures/scholarly-network.ts";

Deno.test("identifiers: own (from the URL / page head) and linked (in the body) are kept apart", () => {
  assertEquals(ownIdentifier("https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2021.757735/full"),
    { kind: "doi", value: "10.3389/fnhum.2021.757735" });
  assertEquals(ownIdentifier("https://www.nature.com/articles/s44172-025-00417-2"), { kind: "doi", value: "10.1038/s44172-025-00417-2" });
  assertEquals(ownIdentifier("https://pmc.ncbi.nlm.nih.gov/articles/PMC12882250/"), { kind: "pmcid", value: "PMC12882250" });
  assertEquals(ownIdentifier("https://pubmed.ncbi.nlm.nih.gov/41508048/"), { kind: "pmid", value: "41508048" });
  assertEquals(ownIdentifier("https://arxiv.org/abs/2401.00001v2"), { kind: "arxiv", value: "2401.00001" });
  assertEquals(ownIdentifier("https://pressbooks.umn.edu/sensationandperception/chapter/motion-sickness/"), null);
  assertEquals(cleanDoi("10.1000/ABC.123)."), "10.1000/abc.123");
  // the pressbooks chapter CITES a paper; that is a linked DOI, never its own identity
  const hz = JSON.parse(Deno.readTextFileSync(new URL("./fixtures/job-100hz.json", import.meta.url)));
  assertEquals(linkedDois(hz.cited_texts[2].content, null), ["10.1007/978-3-319-97493-4_1"]);
  assertEquals(headDoi(hz.cited_texts[8].content), "10.1186/s12984-025-01858-8");
});

Deno.test("every paper source in the fixture jobs carries metadata.scholarly - resolved, or explicitly unresolved", async () => {
  const net = fixtureNetwork();
  const resolver = fixtureResolver(net);
  let papers = 0;
  for (const f of ["job-100hz", "job-optiplex"]) {
    const job = JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${f}.json`, import.meta.url)));
    for (const s of job.cited_texts as Array<{ url: string; content: string }>) {
      const id = ownIdentifier(s.url, s.content);
      if (!id) continue;
      papers++;
      const rec = await resolver.resolve(id, id.kind === "pmcid" ? headDoi(s.content) : null);
      assert(["resolved", "unresolved"].includes(rec.state), s.url);
      assert(rec.resolved_at, "resolved_at is recorded");
      if (rec.state === "unresolved") { assert(rec.reason, "an unresolved record says why"); continue; }
      assert(rec.doi, `${s.url}: doi`);
      assertEquals(typeof rec.cited_by, "number", `${s.url}: cited_by`);
      assert(rec.published, `${s.url}: published`);
      assert(rec.authors.length > 0, `${s.url}: authors`);
      for (const a of rec.authors) {
        // a works_count is a number, or null WITH a reason on the record - never a silent 0
        if (a.works_count === null) assert(rec.reason && /works_count unresolved/.test(rec.reason), `${s.url}: null works_count without a reason`);
        else assertEquals(typeof a.works_count, "number");
      }
    }
  }
  assertEquals(papers, 4, "frontiers, nature, springer and PMC carry an own identifier");
  assert(net.calls.length > 0 && net.calls.every((c) => c.client === PROXY_CLIENT), "every resolver call went through the egress proxy");
});

Deno.test("OpenAlex first, Crossref fallback: the nature paper resolves via Crossref with works_count stated unresolved", async () => {
  const rec = await fixtureResolver().resolve({ kind: "doi", value: "10.1038/s44172-025-00417-2" });
  assertEquals(rec.state, "resolved");
  assertEquals(rec.via, "crossref");
  assertEquals(rec.cited_by, 3);
  assertEquals(rec.published, "2025-05-02");
  assert(rec.authors.every((a) => a.works_count === null));
  assert(/OpenAlex 404/.test(rec.reason ?? "") && /works_count unresolved/.test(rec.reason ?? ""), rec.reason);
});

Deno.test("OpenAlex resolves cited_by, publication date and each author's works_count", async () => {
  const rec = await fixtureResolver().resolve({ kind: "doi", value: "10.3389/fnhum.2021.757735" });
  assertEquals([rec.state, rec.via, rec.cited_by, rec.published], ["resolved", "openalex", 21, "2021-11-09"]);
  assertEquals(rec.authors.map((a) => a.works_count), [35, 212, 12]);
});

Deno.test("both services down: an explicit unresolved record, nulls not zeros", async () => {
  const rec = await fixtureResolver().resolve({ kind: "arxiv", value: "2401.00001" });
  assertEquals(rec.state, "unresolved");
  assertEquals(rec.cited_by, null);
  assertEquals(rec.authors, []);
  assert(/OpenAlex 503/.test(rec.reason!) && /Crossref 503/.test(rec.reason!), rec.reason);
});

Deno.test("no OpenAlex key: OpenAlex is not called unkeyed; Crossref still answers", async () => {
  const net = fixtureNetwork();
  const r = createScholarlyResolver({ fetch: net.fetch, openalexKey: "", mailto: "m@example.invalid" });
  const rec = await r.resolve({ kind: "doi", value: "10.1038/s44172-025-00417-2" });
  assertEquals(rec.via, "crossref");
  assert(!net.calls.some((c) => c.url.includes("openalex")), "an unkeyed OpenAlex call was made");
});

Deno.test("EGRESS: a resolver whose fetch bypasses FETCH_PROXY_URL cannot be built", () => {
  assertThrows(() => createScholarlyResolver({ fetch: fetch as unknown as ProxiedFetch, openalexKey: "k", mailto: "m" }), Error, "proxiedFetch");
  assertThrows(() => proxiedFetch(fetch, null), Error, "no egress proxy client");
  // the explicit, configured direct choice is allowed and labelled as such
  assertEquals(proxiedFetch(fetch, null, { direct: true }).egress, "direct (FETCH_PROXY_URL is empty by configuration)");
});

// ── attempt 2: secret hygiene (tester t-rw-p3a finding 3) ──────────────────────────────────────
// Attempt 1 stored the fetch error's message as the reason; Deno's message carries the request URL
// - `?api_key=<key>&mailto=<mailto>` - and that reason was persisted and served (adv5/adv6). A
// reason must never carry the key, the mailto, a query string or the words that introduce them.
const SECRET = `SECRETKEY-${crypto.randomUUID().slice(0, 8)}`;
const MAILTO = "tester-guard@example.invalid";
function assertNoSecret(where: string, text: unknown) {
  const s = JSON.stringify(text ?? "");
  for (const bad of [SECRET, MAILTO, encodeURIComponent(MAILTO), "api_key", "mailto", "?"]) {
    assert(!s.includes(bad), `${where} carries '${bad}': ${s}`);
  }
}
/** A network that fails the way Deno's fetch does: the error MESSAGE names the full URL. */
function failingNetwork(kind: "error" | "timeout" | "status" | "garbage") {
  const raw = (url: string, init: RequestInit & { client?: unknown } = {}): Promise<Response> => {
    if (init.client !== PROXY_CLIENT) return Promise.reject(new Error("EGRESS BYPASS"));
    if (kind === "error") return Promise.reject(new TypeError(`error sending request for url (${url}): client error (Connect): unsuccessful tunnel`));
    if (kind === "timeout") { const e = new Error(`request to ${url} timed out`); e.name = "TimeoutError"; return Promise.reject(e); }
    if (kind === "status") return Promise.resolve(new Response(`upstream said no to ${url}`, { status: 502 }));
    return Promise.resolve(new Response(`<html>${url}</html>`, { status: 200 }));
  };
  return createScholarlyResolver({ fetch: proxiedFetch(raw, PROXY_CLIENT), openalexKey: SECRET, mailto: MAILTO });
}

Deno.test("SECRETS: a failed resolver call's reason never carries the OpenAlex key, the mailto or the request URL", async () => {
  for (const kind of ["error", "timeout", "status", "garbage"] as const) {
    for (const id of [{ kind: "doi", value: "10.5555/tester.p3a.0001" }, { kind: "arxiv", value: "2401.00001" }, { kind: "pmid", value: "41508048" }] as const) {
      const rec = await failingNetwork(kind).resolve(id, null);
      assertEquals(rec.state, "unresolved", `${kind} ${id.kind}`);
      assert(rec.reason, "an unresolved record says why");
      assertNoSecret(`${kind} ${id.kind} reason`, rec.reason);
      assertNoSecret(`${kind} ${id.kind} record`, rec);
    }
  }
});

Deno.test("SECRETS: every reason the resolver forms is an allow-listed reason code (no free text)", async () => {
  const reasons: string[] = [];
  for (const kind of ["error", "timeout", "status", "garbage"] as const) {
    reasons.push((await failingNetwork(kind).resolve({ kind: "doi", value: "10.5555/x" })).reason!);
    reasons.push((await failingNetwork(kind).resolve({ kind: "pmid", value: "1234567" }, null)).reason!);
  }
  const net = fixtureNetwork();
  const ok = fixtureResolver(net);
  for (const id of [{ kind: "doi", value: "10.1038/s44172-025-00417-2" }, { kind: "arxiv", value: "2401.00001" }, { kind: "doi", value: "10.3389/fnhum.2021.757735" }] as const) {
    const r = (await ok.resolve(id)).reason;
    if (r) reasons.push(r);
  }
  reasons.push((await createScholarlyResolver({ fetch: net.fetch, openalexKey: "", mailto: MAILTO }).resolve({ kind: "doi", value: "10.1038/s44172-025-00417-2" })).reason!);
  assert(reasons.length >= 10, `reasons: ${reasons.length}`);
  for (const r of reasons) assert(scholarlyReasonAllowed(r), `not an allow-listed reason: ${r}`);
  // and the guard catches the attempt 1 shape
  assert(!scholarlyReasonAllowed(`OpenAlex error: error sending request for url (https://api.openalex.org/works/x?api_key=${SECRET}&mailto=x)`));
  assert(!scholarlyReasonAllowed("OpenAlex 404 (evil.example)"));
});

Deno.test("SECRETS: what is STORED goes through the allow-list - a legacy reason and a credential-shaped reason line are redacted", () => {
  const legacy = { state: "unresolved", identifier: { kind: "doi", value: "10.1/x" }, doi: "10.1/x", cited_by: null, published: null,
    authors: [], resolved_at: "2026-10-18T00:00:00Z", via: null, extra: "dropped",
    reason: `OpenAlex error: error sending request for url (https://api.openalex.org/works/x?api_key=${SECRET}&mailto=${MAILTO})` };
  const stored = safeScholarlyRecord(legacy);
  assertNoSecret("stored record", stored);
  assertEquals(Object.keys(stored).sort(), ["authors", "cited_by", "doi", "identifier", "published", "reason", "resolved_at", "state", "via"]);
  assert(/redacted/.test(String(stored.reason)));
  assertEquals(safeScholarlyRecord({ ...legacy, reason: "OpenAlex 404 (api.openalex.org); Crossref 503 (api.crossref.org)" }).reason,
    "OpenAlex 404 (api.openalex.org); Crossref 503 (api.crossref.org)");
  assert(/redacted/.test(safeReasonText(`doi 10.1/x UNRESOLVED (see https://api.openalex.org/works/x?api_key=${SECRET}): scored as general`)));
  assertEquals(safeReasonText("domain class general: 0.22"), "domain class general: 0.22");
});

Deno.test({
  name: "SECRETS: the workbench serves signals.scholarly.reason with the SAME allow-list (no drift by convention)",
  ignore: (() => { try { Deno.statSync(new URL("../../docker/workbench/src/contracts/logic/scholarly_reason.ts", import.meta.url)); return false; } catch { return true; } })(),
  async fn() {
    const wb = await import(new URL("../../docker/workbench/src/contracts/logic/scholarly_reason.ts", import.meta.url).href);
    assertEquals(wb.SCHOLARLY_REASON_PATTERN, SCHOLARLY_REASON_PATTERN);
    const leaky = { state: "unresolved", reason: `OpenAlex error: https://api.openalex.org/works/x?api_key=${SECRET}&mailto=t@x` };
    assertNoSecret("workbench safeScholarly", wb.safeScholarly(leaky));
    assertNoSecret("workbench safeSignals", wb.safeSignals({ scholarly: leaky, domain_class: "general" }));
  },
});

// ── attempt 3 (tester t-rw-p3a-2 near-misses (4)) ─────────────────────────────────────────────
/** A network that ANSWERS 200 with a given body for every OpenAlex and Crossref call. */
function answering(openalex: (url: string) => unknown, crossref: (url: string) => unknown) {
  const raw = (url: string, init: RequestInit & { client?: unknown } = {}): Promise<Response> => {
    if (init.client !== PROXY_CLIENT) return Promise.reject(new Error("EGRESS BYPASS"));
    const body = url.includes("api.openalex.org") ? openalex(url) : crossref(url);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  };
  return createScholarlyResolver({ fetch: proxiedFetch(raw, PROXY_CLIENT), openalexKey: SECRET, mailto: MAILTO });
}
const ID = { kind: "doi", value: "10.5555/tester.p3a.0003" } as const;
const GOOD_WORK = { id: "https://openalex.org/W9000000009", doi: "https://doi.org/10.5555/tester.p3a.0003", publication_date: "2024-01-02",
  cited_by_count: 4, authorships: [{ author: { id: "https://openalex.org/A9000000009", display_name: "Synthetic Author" } }] };

Deno.test("attempt 3: a 200 whose body is an ERROR object, or lacks the work's fields, is UNRESOLVED - never resolved (OpenAlex and Crossref)", async () => {
  const errorBodies: unknown[] = [{ error: "Not Found", message: "the work does not exist" }, { message: "rate limited" }, {}, { doi: "10.5555/x" },
    { id: "not-an-openalex-id", doi: "x" }, [], "a string", null];
  for (const oa of errorBodies) {
    for (const cr of [{ status: "failed", message: [{ type: "x", message: "no" }] }, { status: "ok" }, { status: "ok", message: { title: ["no DOI"] } }, {}, null]) {
      const rec = await answering(() => oa, () => cr).resolve(ID);
      assertEquals(rec.state, "unresolved", `OpenAlex ${JSON.stringify(oa)} / Crossref ${JSON.stringify(cr)} resolved`);
      assert(scholarlyReasonAllowed(rec.reason), String(rec.reason));
      assert(/OpenAlex unreadable answer \(api\.openalex\.org\); Crossref unreadable answer \(api\.crossref\.org\)/.test(String(rec.reason)), String(rec.reason));
    }
  }
  // a well-formed work still resolves (the authors call answers no results -> works_count null, stated)
  const ok = await answering((u) => (u.includes("/authors") ? { results: [] } : GOOD_WORK), () => null).resolve(ID);
  assertEquals([ok.state, ok.via, ok.cited_by], ["resolved", "openalex", 4]);
});

Deno.test("attempt 3: a 200 SUCCESS body that echoes the request (key, mailto, URL query) into a stored field is not stored - the answer is unreadable", async () => {
  const echoes = (url: string) => [url, `x ${SECRET}`, MAILTO, encodeURIComponent(MAILTO), `https%3A%2F%2Fapi.openalex.org%2Fworks%3Fapi_key%3D${SECRET}`];
  for (const field of ["doi", "display_name", "publication_date"]) {
    for (let i = 0; i < 5; i++) {
      const oa = (url: string) => {
        if (url.includes("/authors")) return { results: [] };
        const w = structuredClone(GOOD_WORK) as Record<string, unknown> & { authorships: Array<{ author: Record<string, unknown> }> };
        if (field === "display_name") w.authorships[0].author.display_name = echoes(url)[i];
        else w[field] = echoes(url)[i];
        return w;
      };
      const cr = (url: string) => ({ status: "ok", message: { DOI: "10.5555/tester.p3a.0003", author: [{ given: echoes(url)[i], family: "F" }] } });
      const rec = await answering(oa, cr).resolve(ID);
      assertNoSecret(`${field} echo ${i}`, rec);
      assertEquals(rec.state, "unresolved", `${field} echo ${i} was stored as ${JSON.stringify(rec)}`);
    }
  }
});

Deno.test("attempt 3: STORED and SERVED records keep each data field only in its shape and free of anything credential-shaped", () => {
  const dirty = { state: "resolved", identifier: { kind: "doi", value: `10.1/x?api_key=${SECRET}` }, doi: `https://api.openalex.org/works/x?mailto=${MAILTO}`,
    cited_by: -3, published: `2020 ${SECRET}`,
    authors: [{ id: SECRET, name: `Name ${SECRET}`, works_count: "12" }, { id: "https://orcid.org/0000-0002-1694-233X", name: "Jane Doe", works_count: 12 }],
    resolved_at: `now ${SECRET}`, via: `openalex?api_key=${SECRET}`, reason: "OpenAlex 404 (api.openalex.org)" };
  const stored = safeScholarlyRecord(dirty);
  assertNoSecret("stored", stored);
  assertEquals(stored.identifier, null);
  assertEquals([stored.doi, stored.cited_by, stored.published, stored.resolved_at, stored.via], [null, null, null, null, null]);
  assertEquals(stored.authors, [{ id: null, name: null, works_count: null }, { id: "https://orcid.org/0000-0002-1694-233X", name: "Jane Doe", works_count: 12 }]);
  const clean = { state: "resolved", identifier: { kind: "doi", value: "10.1038/s44172-025-00417-2" }, doi: "10.1038/s44172-025-00417-2", cited_by: 3,
    published: "2025-05-02", authors: [{ id: null, name: "Synthetic Crossref-One", works_count: null }], resolved_at: "2026-10-18T00:00:00.000Z", via: "crossref",
    reason: "Crossref fallback: author works_count unresolved" };
  assertEquals(safeScholarlyRecord(clean), clean);
});

// One vector list, both implementations (research-service scholarly.ts and the workbench's logic/scholarly_reason.ts).
const REDACT: string[] = [
  `OpenAlex 401 bare ${SECRET} rejected`,
  `https%3A%2F%2Fapi.openalex.org%2Fworks%2Fx%3Fapi_key%3D${SECRET}`,
  "see https%253A%252F%252Fapi.openalex.org%252Fworks%253Fmailto%253Dx",
  `doi 10.1/x UNRESOLVED (https://api.openalex.org/works/x?api_key=${SECRET}): scored as general`,
  "x-api-key: abc", "Authorization: Bearer abc", "mailto:someone", "token=abc",
  "ghp_16CharsOrMoreToken1234567890", "sk-abcdefghijklmnop1234",
];
const KEEP: string[] = [
  "domain class general: 0.22", "doi 10.1038/s44172-025-00417-2 resolved via crossref", "pmcid PMC12882250 resolved via openalex",
  "arxiv 2401.00001 resolved via openalex", "paper score p1: base 0.6 (credible on publication)",
  "admission record d15 weights v1 paper p1", "author stated (Jane Q. Public-Smith): +0.05", "primary: the subject's own domain",
  "found via lead 7e570000-0000-4000-8000-0000000000f1", "orcid 0000-0002-1694-233X", "release/general: 0.1 x weight 1 = 0.1 (weights v1)",
  "OpenAlex 404 (api.openalex.org); Crossref 503 (api.crossref.org)", "100% of the lines supported",
];
Deno.test("attempt 3: safeReasonText refuses a bare key and a percent-encoded query and keeps every reason the model forms (research service)", () => {
  for (const r of REDACT) assertEquals(safeReasonText(r), "reason redacted (it carried a URL or credential-shaped text)", r);
  for (const r of KEEP) assertEquals(safeReasonText(r), r, r);
});
Deno.test({
  name: "attempt 3: the workbench's serving-side scrubber is the SAME (patterns equal, the same vectors, the same record rules)",
  ignore: (() => { try { Deno.statSync(new URL("../../docker/workbench/src/contracts/logic/scholarly_reason.ts", import.meta.url)); return false; } catch { return true; } })(),
  async fn() {
    const wb = await import(new URL("../../docker/workbench/src/contracts/logic/scholarly_reason.ts", import.meta.url).href);
    const rs = await import("./scholarly.ts") as Record<string, unknown>;
    for (const k of ["SECRET_SHAPED_PATTERN", "TOKEN_SHAPED_PATTERN", "NOT_A_TOKEN_PATTERN", "SCHOLARLY_REASON_PATTERN", "REDACTED_REASON"]) {
      assertEquals(wb[k], rs[k], k);
    }
    for (const r of REDACT) assertEquals(wb.safeReasonText(r), rs.REDACTED_REASON, r);
    for (const r of KEEP) assertEquals(wb.safeReasonText(r), r, r);
    const dirty = { state: "resolved", doi: `x?api_key=${SECRET}`, authors: [{ id: SECRET, name: "n", works_count: 1 }], via: "openalex" };
    assertEquals(wb.safeScholarly(dirty), safeScholarlyRecord(dirty));
    assertNoSecret("workbench safeScholarly", wb.safeScholarly(dirty));
  },
});
