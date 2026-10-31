// A stand-in for the LLM gateway, for the disposable sessions lab only (rw-p4b-sessions). It never
// answers a model or an embedding call - the request is held open - so a research job the dispatcher
// claims stays `running` for the length of the lab, as a real job does while it waits on the model.
// It answers llm-queue's GET /observe/queue/estimate pass-through with a lane wide enough that every
// job of the lab is claimed at once (P4a: the research-branch lane is read back from there).
Deno.serve({ port: 8080 }, (req) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/observe/queue/estimate")) return Response.json({ max_concurrency: 40, capacity_declared: true });
  if (url.pathname.endsWith("/health/liveliness")) return new Response("ok");
  // held open: the caller's own timeout or abort ends it
  return new Promise<Response>((resolve) => req.signal.addEventListener("abort", () => resolve(new Response("aborted", { status: 499 }))));
});
