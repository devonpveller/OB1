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
// rw-p6a-resolve attempt 2:
//   forbidden <file>...                    no <script, <iframe, on*=, javascript:, vbscript:, data:text/html, {=html},
//                                          COMMENT-LEAK in an MD/TXT file, a DOCX's XML parts, a PDF's text layer
//                                          and its raw objects (link annotations); an MD file also re-read by pandoc
//                                          (raw HTML + raw attributes ON) has no raw node
//   title    <pdf|docx> <note.md>          the output carries the note's frontmatter title LITERALLY
//   fonts    <pdf> <regex>                 a face matching <regex> is embedded
// rw-p6a-resolve attempt 3:
//   structure <file>...                    what a reader could follow: the MD as pandoc renders it to HTML (no
//                                          unsafe href/src, no on* attribute, no script), the DOCX's external
//                                          relationships and HYPERLINK fields, the PDF's /URI actions and
//                                          JavaScript/Launch/OpenAction/AA - all http(s)/mailto or absent
//   secret   <file> <secret>...            the file (PDF text + objects, DOCX XML, text) carries no secret,
//                                          as written or with tags and whitespace removed; attempt 5: nor to
//                                          a reader (NFKD, marks and invisibles stripped, letters and digits)
// The key is read from $WB_KEY and sent as X-Brain-Key, as Caddy does.
import { pdfFonts, pdfText } from "/app/src/export/pdf_tools.ts";
import { docxXml } from "/app/src/export/zip_read.ts";

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
  const extra = r.headers.get("x-export-mode") ? ` mode ${r.headers.get("x-export-mode")} unresolved ${r.headers.get("x-export-unresolved")}` : "";
  console.log(`status ${r.status} bytes ${b.length} type ${r.headers.get("content-type")} style ${r.headers.get("x-citation-style")}${extra}`);
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
} else if (mode === "forbidden") {
  const FORBIDDEN = /<script|<iframe|\bon[a-z]+\s*=|javascript:|vbscript:|data:text\/html|\{=html\}|COMMENT-LEAK/i;
  for (const file of args) {
    const b = await Deno.readFile(file);
    const views: [string, string][] = file.endsWith(".pdf")
      ? [["text layer", await pdfText(b)], ["objects", new TextDecoder("latin1").decode(b)]]
      : file.endsWith(".docx") ? [["xml", await docxXml(b)]] : [["text", new TextDecoder().decode(b)]];
    if (file.endsWith(".md")) {
      const p = new Deno.Command("pandoc", { args: ["-f", "markdown", "-t", "native", file], stdout: "piped" });
      const raw = [...new TextDecoder().decode((await p.output()).stdout).matchAll(/Raw(?:Inline|Block) \(\s*Format "(\w+)"/g)].map((m) => m[1]);
      views.push(["pandoc re-read raw nodes", raw.length ? `<script raw nodes: ${raw.join(",")}` : ""]);
    }
    for (const [what, t] of views) {
      const hit = FORBIDDEN.exec(t)?.[0];
      console.log(`${hit ? "FAIL" : "PASS"} forbidden: ${file.split("/").pop()} (${what})${hit ? `: carries ${hit}` : ": clean"}`);
      if (hit) rc = 1;
    }
  }
} else if (mode === "title") {
  const note = await Deno.readTextFile(args[1]);
  const title = /^title:[ \t]*'(.*)'[ \t]*$/m.exec(note)![1];
  const b = await Deno.readFile(args[0]);
  let t: string;
  if (args[0].endsWith(".pdf")) t = await pdfText(b);
  else {
    const p = new Deno.Command("pandoc", { args: ["-f", "docx", "-t", "plain", "--wrap=none", "--standalone", args[0]], stdout: "piped" });
    t = new TextDecoder().decode((await p.output()).stdout);
  }
  const ok = t.replace(/\s+/g, " ").includes(title);
  console.log(`${ok ? "PASS" : "FAIL"} title: ${args[0].split("/").pop()} carries the title literally (${title.length} chars)`);
  if (!ok) rc = 1;
} else if (mode === "fonts") {
  const fonts = await pdfFonts(await Deno.readFile(args[0]));
  const ok = fonts.some((x) => new RegExp(args[1], "i").test(x));
  console.log(`${ok ? "PASS" : "FAIL"} fonts: ${fonts.join(", ")}`);
  if (!ok) rc = 1;
} else if (mode === "structure") {
  // attempt 3: what a READER of each output could follow or execute, checked WITHOUT the workbench's
  // own verifier (verify.ts): the MD rendered by pandoc to HTML (raw HTML and every attribute syntax
  // ON, pandoc's defaults), the DOCX's relationships and field codes, the PDF's link and other actions.
  const SAFE = /^(https?:\/\/|mailto:)/i;
  for (const file of args) {
    const b = await Deno.readFile(file);
    const name = file.split("/").pop();
    const bad: string[] = [];
    if (file.endsWith(".md")) {
      const p = new Deno.Command("pandoc", { args: ["-f", "markdown", "-t", "html", file], stdout: "piped" });
      const html = new TextDecoder().decode((await p.output()).stdout);
      for (const m of html.matchAll(/\s(href|src)="([^"]*)"/g)) if (!SAFE.test(m[2]) && !/^#/.test(m[2]) && !/^[\w./-]+$/.test(m[2])) bad.push(`${m[1]}=${m[2]}`);
      for (const m of html.matchAll(/<[^>]*\s(on[a-z]+)=/gi)) bad.push(`attribute ${m[1]}`);
      if (/<script|<iframe/i.test(html)) bad.push("a script or iframe element");
    } else if (file.endsWith(".docx")) {
      const xml = await docxXml(b);
      for (const m of xml.matchAll(/<Relationship\b[^>]*Target="([^"]*)"[^>]*TargetMode="External"/g)) if (!SAFE.test(m[1])) bad.push(`relationship ${m[1]}`);
      for (const m of xml.matchAll(/HYPERLINK\s+"([^"]*)"/g)) if (!SAFE.test(m[1])) bad.push(`field ${m[1]}`);
    } else if (file.endsWith(".pdf")) {
      const raw = new TextDecoder("latin1").decode(b);
      for (const m of raw.matchAll(/\/URI\s*\(((?:\\.|[^\\)])*)\)/g)) if (!SAFE.test(m[1])) bad.push(`URI ${m[1]}`);
      if (/\/URI\s*</.test(raw)) bad.push("a hex-encoded URI");
      for (const k of ["/JavaScript", "/JS", "/Launch", "/OpenAction", "/AA", "/SubmitForm", "/EmbeddedFile"]) if (new RegExp(`${k}[\\s/<(\\[]`).test(raw)) bad.push(k);
    } else {
      const t = new TextDecoder().decode(b);
      if (/javascript:|vbscript:|data:text\/html|file:\/\//i.test(t)) bad.push("an unsafe-scheme string");
    }
    console.log(`${bad.length ? "FAIL" : "PASS"} structure: ${name}${bad.length ? `: ${bad.slice(0, 5).join(" | ")}` : ": no unsafe target, attribute, raw node or action"}`);
    if (bad.length) rc = 1;
  }
} else if (mode === "secret") {
  // attempt 3: no output carries the key or the mailto, as written, tags stripped, whitespace removed
  const [file, ...secrets] = args;
  const b = await Deno.readFile(file);
  const views = file.endsWith(".pdf") ? [await pdfText(b), new TextDecoder("latin1").decode(b)] : file.endsWith(".docx") ? [await docxXml(b)] : [new TextDecoder().decode(b)];
  // attempt 5: and to a READER - marks and invisible characters stripped after NFKD, letters and digits only
  const rd = (v: string) => v.normalize("NFKD").replace(/[\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const hits = secrets.filter((s) => views.some((v) => v.includes(s) || v.replace(/\s+/g, "").includes(s) || v.replace(/<[^>]*>/g, "").replace(/\s+/g, "").includes(s) || rd(v).includes(rd(s))));
  console.log(`${hits.length ? "FAIL" : "PASS"} secret: ${file.split("/").pop()} ${hits.length ? `carries ${hits.length} configured secret(s)` : "carries neither secret"}`);
  if (hits.length) rc = 1;
} else {
  console.error("usage: export-client.ts get|hundred|refused|headers|cjk|forbidden|title|fonts|structure|secret ...");
  rc = 2;
}
Deno.exit(rc);
