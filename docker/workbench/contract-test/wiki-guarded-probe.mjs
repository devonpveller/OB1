// wiki-guarded-probe.mjs - lab probe for research-workbench rw-wiki-guarded-pages, run by run-wiki-guarded-lab.ps1 in a
// node container on the lab's internal network, against the lab's PostgREST (OPEN_BRAIN_URL) with the real guards of
// slots 380 / 390 / 430 / 440 on. Never point it at a live stack. Prints one JSON line: PROBE {...} - statuses, counts and
// booleans only (no page text; MARK, the planted marker, is only ever searched for).
//   MODE=guards  the SAME planted private text, four ways (an archived idea thought - 380; a private report's source - 390;
//                a private thought - 440 links; a withheld page's text - 440 text), as a NOTE (must be refused: 401/403 +
//                the guards' one message) and as a compiled page (must be withheld: 2xx, X-Wiki-Withheld 1, no row back)
//   MODE=writer  the REAL writer (SHARED = a recipes/_shared directory: this change's or the base's) meets the refusal in
//                its three paths: a compile flush, the next cycle's retry, the viewer-style reconcile repair
//   MODE=routes  the lab viewer (PROBE_VIEWER) as two identities: no route shows the marker; its health
const SHARED = process.env.SHARED || "/shared";
const OB = (process.env.OPEN_BRAIN_URL || "").replace(/\/+$/, "");
const VIEWER = (process.env.PROBE_VIEWER || "").replace(/\/+$/, "");
const MODE = process.env.MODE || "guards";
const tag = process.env.TAG || "t";
const MARK = process.env.MARK || "";
const IDS = { idea: process.env.IDEA_THOUGHT, priv: process.env.PRIV_THOUGHT, report: process.env.REPORT_SOURCE };
const TEXT = process.env.WITHHELD_TEXT || "";
const fs = await import("node:fs");
const path = await import("node:path");
const crypto = await import("node:crypto");
const out = { mode: MODE, tag };
const bodyOf = (kind) => ({
  idea: `A page that carries ${MARK} and cites [[thought/${IDS.idea}]] among others.`,
  priv: `A page that carries ${MARK} and cites [[Content/Thought/${IDS.priv}]] among others.`,
  report: `A page that carries ${MARK} and cites content/source/${IDS.report} among others.`,
  text: TEXT,
})[kind];
const KINDS = ["idea", "report", "priv", "text"];
// rw-rest-door-auth (slot 450): every caller sends its OWN token. The writer (and this probe's direct note / row requests, which
// stand in for it) is the wiki caller (role ob_rest_wiki); the viewer-style repair below is the viewer caller (ob_rest_viewer).
// The tokens are lab-minted (rest-door-lab.ps1); wiki-pages.mjs and reconcile-wiki-pages.mjs read OPEN_BRAIN_REST_TOKEN per call.
const TOK_WIKI = process.env.REST_TOKEN_WIKI || "";
const TOK_VIEWER = process.env.REST_TOKEN_VIEWER || "";
process.env.OPEN_BRAIN_REST_TOKEN = TOK_WIKI;
const H = { "content-type": "application/json", authorization: `Bearer ${TOK_WIKI}` };
async function rowsHave(slugs) {
  const list = slugs.map((s) => `"${s}"`).join(",");
  const r = await fetch(`${OB}/rest/v1/wiki_pages?select=slug&slug=in.(${encodeURIComponent(list)})`, { headers: H });
  return new Set((await r.json()).map((x) => x.slug));
}

if (MODE === "guards") {
  out.guards = {};
  const all = [];
  for (const kind of KINDS) {
    const note = { slug: `content/notebooks/lab-${tag}/g-${kind}`, page_class: "note", title: `G ${kind}`, body: bodyOf(kind), tags: [], links: [], frontmatter: {} };
    const comp = { slug: `content/topic/g-${kind}-${tag}`, page_class: "entity", title: `G ${kind}`, body: bodyOf(kind), tags: [], links: [], frontmatter: {} };
    all.push(note.slug, comp.slug);
    const rn = await fetch(`${OB}/rest/v1/wiki_pages?on_conflict=slug&select=slug`, { method: "POST", headers: { ...H, prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify([note]) });
    const tn = await rn.text();
    const rc = await fetch(`${OB}/rest/v1/wiki_pages?on_conflict=slug&select=slug`, { method: "POST", headers: { ...H, prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify([comp]) });
    const tc = await rc.text();
    let back = -1; try { back = JSON.parse(tc).length; } catch { /* not JSON */ }
    out.guards[kind] = {
      noteRefused: (rn.status === 401 || rn.status === 403) && /"code":"42501"/.test(tn) && tn.includes("wiki_pages: this page cannot be saved"),
      compiledWithheld: rc.status >= 200 && rc.status < 300 && rc.headers.get("x-wiki-withheld") === "1" && back === 0,
    };
  }
  const have = await rowsHave(all);
  out.rowsLanded = have.size;
}

if (MODE === "writer") {
  const wp = await import(path.join(SHARED, "wiki-pages.mjs"));
  const rc = await import(path.join(SHARED, "reconcile-wiki-pages.mjs"));
  const vault = process.env.WIKI_GIT_DIR;
  const nbDir = path.join(vault, "content", "notebooks", `lab-${tag}`);
  fs.mkdirSync(nbDir, { recursive: true });
  const page = (title, body) => `---\ntitle: ${title}\n---\n${body}\n`;
  const sl = (n) => `content/notebooks/lab-${tag}/${n}`;
  const fl = (n) => path.join(nbDir, `${n}.md`);
  const recFile = path.join(vault, "content", ".withheld-pages.json");
  const rec = () => { try { return fs.readFileSync(recFile, "utf8"); } catch { return ""; } };
  const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
  const logs = [];
  const [l0, e0] = [console.log, console.error];
  console.log = (x) => logs.push(String(x)); console.error = (x) => logs.push(String(x));
  try {
    // a. a compile flush: a refused note (440 private thought) and a clean note in ONE batch
    wp.writeWikiPage(fl("w-refused"), page("W refused", bodyOf("priv")));
    wp.writeWikiPage(fl("w-clean"), page("W clean", "A notebook note with shared text only."));
    const exit = await wp.finishWikiPages(`guarded-${tag}`, { outDir: path.join(vault, "content") });
    const h1 = await rowsHave([sl("w-refused"), sl("w-clean")]);
    out.flush = { exit, cleanRow: h1.has(sl("w-clean")), refusedRow: h1.has(sl("w-refused")), refusedFile: fs.existsSync(fl("w-refused")),
      unsynced: wp.unsyncedWikiPages().length, recorded: rec().includes(hash(sl("w-refused"))) };
    // b. the next cycle's retry: a refused note (380 idea) and a clean one, recorded as left by an outage
    fs.writeFileSync(fl("r-refused"), page("R refused", bodyOf("idea")));
    fs.writeFileSync(fl("r-clean"), page("R clean", "Another note with shared text only."));
    const at = new Date().toISOString();
    const uf = path.join(vault, "content", ".unsynced-rows.json");
    fs.writeFileSync(uf, JSON.stringify({ rows: { [sl("r-refused")]: { error: "The operation was aborted due to timeout", tag: "lab", at },
      [sl("r-clean")]: { error: "The operation was aborted due to timeout", tag: "lab", at } } }));
    const r1 = await wp.retryUnsyncedRows({ outDir: path.join(vault, "content"), vaultDir: vault, log: () => {} });
    const r2 = await wp.retryUnsyncedRows({ outDir: path.join(vault, "content"), vaultDir: vault, log: () => {} });
    const left = Object.keys(JSON.parse(fs.readFileSync(uf, "utf8")).rows || {});
    const h2 = await rowsHave([sl("r-clean")]);
    out.retry = { firstLanded: r1.landed, secondRetried: r2.retried, recordLeft: left.length, cleanRow: h2.has(sl("r-clean")),
      refusedFile: fs.existsSync(fl("r-refused")), recorded: rec().includes(hash(sl("r-refused"))) };
    // c. the viewer-style repair in a fresh process state: a refused note (440 text) with no row, and a clean one
    wp._resetWikiPagesForTests();
    fs.writeFileSync(fl("v-refused"), page("V refused", bodyOf("text")));
    fs.writeFileSync(fl("v-clean"), page("V clean", "A third note with shared text only."));
    process.env.OPEN_BRAIN_REST_TOKEN = TOK_VIEWER;
    let r;
    try { r = await rc.reconcile({ vault, repair: true, log: () => {} }); } finally { process.env.OPEN_BRAIN_REST_TOKEN = TOK_WIKI; }
    const a = r.after || r;
    const h3 = await rowsHave([sl("v-clean")]);
    out.repair = { cleanRow: h3.has(sl("v-clean")), drift: a.drift, missing: a.missing.length, stale: a.stale.length, orphan: a.orphan.length, withheld: a.withheld || 0 };
    // also refused by the report guard (390) in a fresh flush: the fourth guard through the writer
    wp.writeWikiPage(fl("x-refused"), page("X refused", bodyOf("report")));
    out.flush390 = { exit: await wp.finishWikiPages(`guarded-x-${tag}`, { outDir: path.join(vault, "content") }), refusedFile: fs.existsSync(fl("x-refused")), unsynced: wp.unsyncedWikiPages().length };
  } finally { console.log = l0; console.error = e0; }
  const rtext = rec();
  out.recordClean = !rtext || (!rtext.includes(MARK) && !rtext.includes(`lab-${tag}`) && !/refused/.test(rtext));
  out.logsClean = !logs.join("\n").includes(MARK);
  out.logsNameRefused = /w-refused|r-refused|v-refused|x-refused/.test(logs.join("\n"));
}

if (MODE === "routes") {
  const slugs = (process.env.ROUTE_SLUGS || "").split(",").filter(Boolean);
  const who = [["A", "lab-owner-a"], ["B", "lab-user-b"]];
  const paths = ["/", "/__health"];
  for (const s of slugs) paths.push(`/${s}`, `/${s}/`, `/${s}.md`);
  out.routes = { checked: 0, showMark: 0, renderedDb: 0, statuses: {} };
  for (const [k, sub] of who) {
    for (const p of paths) {
      const r = await fetch(`${VIEWER}${p}`, { headers: { "remote-user": sub, "x-authentik-username": sub, "x-forwarded-user": sub }, redirect: "follow" });
      const t = await r.text();
      out.routes.checked++;
      if (MARK && t.includes(MARK)) out.routes.showMark++;
      if (p !== "/" && p !== "/__health" && r.headers.get("x-wiki-render") === "db") out.routes.renderedDb++;
      out.routes.statuses[`${k}:${r.status}:${r.headers.get("x-wiki-render") || "-"}`] = (out.routes.statuses[`${k}:${r.status}:${r.headers.get("x-wiki-render") || "-"}`] || 0) + 1;
    }
  }
  const h = await fetch(`${VIEWER}/__health`);
  const ht = await h.text();
  let hj = null; try { hj = JSON.parse(ht); } catch { /* text */ }
  out.health = { status: hj?.status ?? null, drift: hj?.reconcile?.drift ?? null, namesLab: ht.includes(`lab-${tag}`), reasons: (hj?.reasons || []).map((x) => String(x).replace(/content\/\S+/g, "<slug>").slice(0, 120)) };
}
console.log("PROBE " + JSON.stringify(out));
