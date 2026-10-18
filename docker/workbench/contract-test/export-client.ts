// The HTTP side of the P6a disposable run (rw-p6a-resolve), run INSIDE a container of the
// workbench's TEST image (pandoc + poppler) on the run's internal network by run-export-tests.ps1.
// Never pointed at a live workbench.
//
//   get      <url> <out-file>              GET with X-Brain-Key; writes the body, prints `status <n> bytes <n>`
//   hundred  <dir>                         the 100-reference exports in <dir> (hundred.pdf / .docx / .md):
//                                          numbered 1..100 inline and in the list, every title the RESOLVED
//                                          one (90 OpenAlex, 10 Crossref), no citation key left as text
//   refused  <json-file> <expect-count> <needle>...
//                                          a 422 body: N unresolved references, each named, the text contains
//                                          every needle
//   headers  <stub-log.json> <key> <mailto> every OpenAlex request carries api_key=<key>, every Crossref request
//                                          mailto=<mailto> (query) and the mailto in its User-Agent; nothing else
//                                          was requested. Exit 1 on any violation (the per-request verdicts printed)
//   cjk      <pdf> <note.md>               the PDF embeds a CJK face and its text layer carries the note's CJK paragraph
// The key is read from $WB_KEY and sent as X-Brain-Key, as Caddy does.
import { pdfFonts, pdfText } from "/app/src/export/pdf_tools.ts";

const [mode, ...args] = Deno.args;
const key = Deno.env.get("WB_KEY") ?? "";
const fail = (m: string) => {
  console.log(`FAIL ${m}`);
  return 1;
};
const seq = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(",");

function numbering(raw: string) {
  const t = raw.replace(/\\([[\]])/g, "$1").replace(/^\s*\d+\s*$/gm, "");
  const at = t.lastIndexOf("References");
  return {
    inline: [...t.slice(0, at).matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])).join(","),
    listed: [...t.slice(at).matchAll(/^\s*\[(\d+)\]/gm)].map((m) => Number(m[1])).join(","),
    list: t.slice(at),
  };
}

async function docxText(path: string) {
  const o = await new Deno.Command("pandoc", { args: ["-f", "docx", "-t", "plain", "--wrap=none", path], stdout: "piped" }).output();
  return new TextDecoder().decode(o.stdout);
}

let rc = 0;
if (mode === "get") {
  const r = await fetch(args[0], { headers: { "x-brain-key": key } });
  const b = new Uint8Array(await r.arrayBuffer());
  await Deno.writeFile(args[1], b);
  console.log(`status ${r.status} bytes ${b.length} type ${r.headers.get("content-type")} style ${r.headers.get("x-citation-style")}`);
} else if (mode === "hundred") {
  const dir = args[0];
  const texts: Record<string, string> = {
    pdf: (await pdfText(await Deno.readFile(`${dir}/hundred.pdf`), true)).replace(/(\p{L})-\n\s*/gu, "$1"),
    docx: await docxText(`${dir}/hundred.docx`),
    md: await Deno.readTextFile(`${dir}/hundred.md`),
  };
  for (const [f, t] of Object.entries(texts)) {
    const n = numbering(t);
    const flat = n.list.replace(/\s+/g, " ");
    const titles = Array.from({ length: 100 }, (_, i) => i + 1).filter((i) =>
      !flat.includes(`Resolved title ${i} (${i <= 90 ? "OpenAlex" : "Crossref"})`));
    const ok = n.inline === seq(100) && n.listed === seq(100) && titles.length === 0 && !/src-f6a|\(src-|Fixture paper record/.test(t);
    console.log(`${ok ? "PASS" : "FAIL"} ${f}: inline 1..100 ${n.inline === seq(100)}, list 1..100 ${n.listed === seq(100)}, ` +
      `resolved titles ${100 - titles.length}/100 (90 OpenAlex + 10 Crossref)${titles.length ? `, missing ${titles.slice(0, 5)}` : ""}`);
    if (!ok) rc = 1;
  }
} else if (mode === "refused") {
  const body = JSON.parse(await Deno.readTextFile(args[0]));
  const want = Number(args[1]);
  const refs = body.references ?? [];
  const text = JSON.stringify(body);
  const named = refs.every((r: Record<string, unknown>) => r.number && r.cited_ref && r.reason);
  const missing = args.slice(2).filter((s) => !text.includes(s));
  const ok = refs.length === want && named && missing.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"} refused: ${refs.length} reference(s) named (expected ${want}); ${body.error}` +
    (missing.length ? `; missing: ${missing.join(" | ")}` : ""));
  for (const r of refs) console.log(`  [${r.number}] ${r.source_id ?? "(no source)"} ${r.identifier ?? ""}: ${r.reason}`);
  if (!ok) rc = 1;
} else if (mode === "headers") {
  const log = JSON.parse(await Deno.readTextFile(args[0])) as { host: string; path: string; query: Record<string, string>; user_agent: string | null }[];
  const [k, mailto] = [args[1], args[2]];
  let oa = 0, cr = 0;
  for (const r of log) {
    let bad = "";
    if (r.host === "api.openalex.stub") {
      oa++;
      if (r.query.api_key !== k) bad = `OpenAlex request without the key (api_key=${r.query.api_key ?? "absent"})`;
    } else if (r.host === "api.crossref.stub") {
      cr++;
      if (r.query.mailto !== mailto) bad = `Crossref request without the mailto (mailto=${r.query.mailto ?? "absent"})`;
      else if (!(r.user_agent ?? "").includes(`mailto:${mailto}`)) bad = "Crossref request whose User-Agent lacks the mailto";
    } else bad = `a request to an unexpected host ${r.host}`;
    if (bad) rc = fail(`${bad}: ${r.host}${r.path}`);
  }
  console.log(`${rc ? "FAIL" : "PASS"} headers: ${oa} OpenAlex request(s) all keyed, ${cr} Crossref request(s) all with the mailto (query + User-Agent); ${log.length} logged`);
} else if (mode === "cjk") {
  // the expected text: the note's first plain CJK paragraph (the runner script stays ASCII)
  const note = await Deno.readTextFile(args[1]);
  const expected = note.split("\n").find((l) => /[一-鿿]/.test(l) && !l.includes("[[") && !l.startsWith("#"))!.replace(/\s+/g, "");
  const pdf = await Deno.readFile(args[0]);
  const fonts = await pdfFonts(pdf);
  const text = (await pdfText(pdf)).replace(/\s+/g, "");
  const ok = fonts.some((f) => /CJK/i.test(f)) && text.includes(expected);
  console.log(`${ok ? "PASS" : "FAIL"} cjk: fonts ${fonts.join(", ")}; text layer carries the fixture text (${expected.length} chars) ${text.includes(expected)}`);
  if (!ok) rc = 1;
} else {
  console.error("usage: export-client.ts get|hundred|refused|headers|cjk ...");
  rc = 2;
}
Deno.exit(rc);
