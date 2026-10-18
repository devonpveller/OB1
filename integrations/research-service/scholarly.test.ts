/**
 * Scholarly metadata through the keyed OpenAlex client with Crossref fallback, via the egress
 * proxy (research-workbench P3a, D15 item 1). Offline: the "network" is fixtures/scholarly/
 * responses.json, served by a stub fetch that records whether every call carried the proxy client.
 * Run: deno test --allow-read scholarly.test.ts
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cleanDoi, createScholarlyResolver, headDoi, linkedDois, ownIdentifier, proxiedFetch, type ProxiedFetch,
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
