// A stand-in egress proxy for the disposable workspace test network only (rw-p2b-workspace). The
// workbench's refetch (a held LINK's replace) goes through FETCH_PROXY_URL and never direct; this
// answers an absolute-form http:// request with new contents for /held/* - "version two" - so the
// refetch makes a new revision. Nothing here reaches any other host.
Deno.serve({ port: 3128 }, (req) => {
  const u = new URL(req.url);
  if (u.pathname.startsWith("/held/")) {
    return new Response(`<html><head><title>Linked held (refetched)</title></head><body><p>version two of ${u.pathname}</p></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response("not found", { status: 404 });
});
