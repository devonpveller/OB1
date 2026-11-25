// A stand-in for openbrain-extract's POST /extract (rw-p5a-intake), for the disposable lab only: a PDF or a
// saved page becomes markdown naming the file (and what its first bytes said); a file whose name carries
// "fail-extract" answers 500. GET /requests answers the names it was handed.
// rwr-upload-sessions: GET /received answers each file's name, length and sha256, so a lab can prove the bytes the intake
// handed on are exactly the file that was uploaded in pieces.
const seen: string[] = [];
const received: { name: string; size: number; sha256: string }[] = [];
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
Deno.serve({ port: 8000 }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/requests") return Response.json({ files: seen });
  if (req.method === "GET" && url.pathname === "/received") return Response.json({ files: received });
  if (req.method !== "POST" || url.pathname !== "/extract") return new Response("not found", { status: 404 });
  const form = await req.formData();
  const file = form.get("file");
  const name = file instanceof File ? file.name : "";
  seen.push(name);
  const bytes = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
  received.push({ name, size: bytes.byteLength, sha256: hex(await crypto.subtle.digest("SHA-256", bytes)) });
  if (!name || name.includes("fail-extract")) return Response.json({ detail: "the lab extractor refuses this file" }, { status: 500 });
  const head = new TextDecoder().decode(bytes.subarray(0, 60));
  return Response.json({ markdown: `# ${name}\n\nextracted text of ${name} (${head.replace(/\s+/g, " ").trim()})\n`, title: name.replace(/\.[a-z]+$/i, ""), metadata: {} });
});
