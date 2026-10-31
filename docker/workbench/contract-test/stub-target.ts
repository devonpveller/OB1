// A lab TARGET site for the disposable fetch-gate test network only (rw-workbench-fetch-posture): the
// host a user-supplied URL names. It logs EVERY request with the caller's address, so a test can prove
// the workbench never contacted it (only the stub gate did). Nothing here reaches any other host.
//   /page/<x>          200 text/html (a raw page: markup and a script the gate's "intake" strips)
//   /plain/<x>         200 text/plain
//   /live/<x>          200 text/html, "version N" - N counts this path's requests (a re-fetch sees new text)
//   /redirect/<x>      302 -> /page/<x>
//   /chain/<x>         301 -> /redirect/<x>  (two hops)
//   /redirect-out/<x>  302 -> http://169.254.169.254/<x>  (a hop the gate refuses)
//   /error/<x>         404
//   /withheld/<x>      200 text/html (the stub gate's "intake" withholds it)
//   /held/<x>          200 text/html, "version two of /held/<x>" (the workspace suite's held link)
//   GET /__log         the request log [{path, from}]  (not itself logged)
const log: { path: string; from: string }[] = [];
const counts = new Map<string, number>();
const html = (title: string, body: string) =>
  new Response(`<html><head><title>${title}</title><script>window.evil = 1</script></head><body><p>${body}</p></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });

Deno.serve({ port: 8080 }, (req, info) => {
  const u = new URL(req.url);
  if (u.pathname === "/__log") return Response.json(log);
  const from = (info.remoteAddr as Deno.NetAddr).hostname;
  log.push({ path: u.pathname, from });
  const [, kind, ...rest] = u.pathname.split("/");
  const x = rest.join("/");
  const n = (counts.get(u.pathname) ?? 0) + 1;
  counts.set(u.pathname, n);
  switch (kind) {
    case "page": return html(`Page ${x}`, `raw page ${x}`);
    case "withheld": return html(`Withheld ${x}`, `a page intake would not label clean ${x}`);
    case "held": return html("Linked held (refetched)", `version two of ${u.pathname}`);
    case "live": return html(`Live ${x}`, `version ${n} of ${x}`);
    case "plain": return new Response(`plain ${x}`, { headers: { "content-type": "text/plain" } });
    case "redirect": return new Response(null, { status: 302, headers: { location: `/page/${x}` } });
    case "chain": return new Response(null, { status: 301, headers: { location: `/redirect/${x}` } });
    case "redirect-out": return new Response(null, { status: 302, headers: { location: `http://169.254.169.254/${x}` } });
    case "error": return new Response("not here", { status: 404 });
    default: return new Response("not found", { status: 404 });
  }
});
