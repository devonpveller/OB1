// A stand-in for openbrain-extract's POST /extract (rw-p5a-intake), for the disposable lab only: a PDF or a
// saved page becomes markdown naming the file (and what its first bytes said); a file whose name carries
// "fail-extract" answers 500. GET /requests answers the names it was handed.
const seen: string[] = [];
Deno.serve({ port: 8000 }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/requests") return Response.json({ files: seen });
  if (req.method !== "POST" || url.pathname !== "/extract") return new Response("not found", { status: 404 });
  const form = await req.formData();
  const file = form.get("file");
  const name = file instanceof File ? file.name : "";
  seen.push(name);
  if (!name || name.includes("fail-extract")) return Response.json({ detail: "the lab extractor refuses this file" }, { status: 500 });
  const head = file instanceof File ? new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()).subarray(0, 60)) : "";
  return Response.json({ markdown: `# ${name}\n\nextracted text of ${name} (${head.replace(/\s+/g, " ").trim()})\n`, title: name.replace(/\.[a-z]+$/i, ""), metadata: {} });
});
