// LAB ONLY (rw-p7a-tts): an Open Notebook SINKHOLE. It answers on open_notebook:5055 in the lab
// network and records every request; GET /__sinkhole/count reports them. The lab runner points the
// old ON_BASE at it - any request it sees is a request the chain should not have made.
const hits: string[] = [];
Deno.serve({ port: Number(Deno.env.get("PORT") ?? "5055"), hostname: "0.0.0.0" }, (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/__sinkhole/count") return Response.json({ count: hits.length, hits });
  hits.push(`${req.method} ${u.pathname}`);
  console.log(`SINKHOLE ${req.method} ${u.pathname}`);
  return Response.json({ job_id: "sinkhole", status: "queued" });
});
