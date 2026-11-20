// inlet-owner-probe.mjs - rw-inlet-owner (slot 440) lab probe, run by run-workspace-tests.ps1 [5r] in a node container on the
// lab's internal network. Never point it at a live stack. Prints one JSON line: PROBE {...} - slugs, statuses, counts and
// booleans only (no page text).
//   1. the REAL wiki writer (SHARED = a recipes/_shared directory) writes a MIXED batch the way a compile does: a page that
//      links an archived idea thought (slot 380's guard withholds it), a page that links a private thought (slot 440's
//      guard withholds it) and a clean page. Both withheld rows must count as WITHHELD (430's X-Wiki-Withheld marker): no
//      file, no row, nothing unsynced, exit 0; the clean page lands.
//   2. every slot-440 function, called through PostgREST with no credentials - directly (PGRST_URL) and through the
//      openbrain-rest door (OPEN_BRAIN_URL): each must be refused (no 2xx); round 1's inlet_owner_default must not exist.
//   IDEA_THOUGHT  an archived idea thought's id (slot 380)    PRIV_THOUGHT  a private thought's id    PRIV_SOURCE  a moved source
const SHARED = process.env.SHARED || "/shared";
const OB = (process.env.OPEN_BRAIN_URL || "").replace(/\/+$/, "");
const PGRST = (process.env.PGRST_URL || "").replace(/\/+$/, "");
const tag = process.env.TAG || "t";
const idea = process.env.IDEA_THOUGHT || "";
const priv = process.env.PRIV_THOUGHT || "";
const src = process.env.PRIV_SOURCE || "";
const out = { tag };
const fs = await import("node:fs");
const path = await import("node:path");
const wp = await import(path.join(SHARED, "wiki-pages.mjs"));
const vault = process.env.WIKI_GIT_DIR;
const dir = path.join(vault, "content", "topic");
fs.mkdirSync(dir, { recursive: true });
const page = (title, body) => `---\ntitle: ${title}\n---\n${body}\n`;
const file = (n) => path.join(dir, `io-${n}-${tag}.md`);
const slug = (n) => `content/topic/io-${n}-${tag}`;

// 1. the mixed batch through the real writer
if (idea && priv) {
  wp.writeWikiPage(file("idea"), page(`IO idea ${tag}`, `A compiled page citing [[thought/${idea}]] among others.`));
  wp.writeWikiPage(file("priv"), page(`IO priv ${tag}`, `A compiled page citing [[Content/Thought/${priv}]] among others.`));
  wp.writeWikiPage(file("clean"), page(`IO clean ${tag}`, `A compiled page with shared text only.`));
  out.exit = await wp.finishWikiPages(`io-${tag}`);
  const list = ["idea", "priv", "clean"].map((n) => `"${slug(n)}"`).join(",");
  const r = await fetch(`${OB}/rest/v1/wiki_pages?select=slug&slug=in.(${encodeURIComponent(list)})`, { headers: { apikey: "local-trust" } });
  const have = new Set((await r.json()).map((x) => x.slug));
  out.rows = Object.fromEntries(["idea", "priv", "clean"].map((n) => [n, have.has(slug(n))]));
  out.files = Object.fromEntries(["idea", "priv", "clean"].map((n) => [n, fs.existsSync(file(n))]));
  out.unsynced = wp.unsyncedWikiPages().length;
  out.withheldMemo = { idea: wp.isWithheldWikiPage(slug("idea")), priv: wp.isWithheldWikiPage(slug("priv")) };
  // the marker on a raw upsert of the two guarded rows: one count per withheld row
  const rows = [
    { slug: slug("raw-idea"), page_class: "entity", title: "raw", body: `see [[Thought/${idea}]]`, tags: [], links: [], frontmatter: {} },
    { slug: slug("raw-priv"), page_class: "entity", title: "raw", body: `see content/thought%2F${priv}`, tags: [], links: [], frontmatter: {} },
  ];
  const m = await fetch(`${OB}/rest/v1/wiki_pages?on_conflict=slug&select=slug`, { method: "POST",
    headers: { "content-type": "application/json", apikey: "local-trust", prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(rows) });
  out.marker = { status: m.status, header: m.headers.get("x-wiki-withheld"), back: (await m.json()).length };
}

// 2. every slot-440 function through PostgREST, no credentials
const calls = {
  inlet_private_source: { p_id: src || "00000000-0000-4000-8000-000000000000", p_sub: "anyone" },
  inlet_private_job: { p_job: "00000000-0000-4000-8000-000000000000", p_sub: "anyone" },
  inlet_owner_page_private: { p_slug: "x", p_title: "x", p_body: "x", p_links: [] },
  inlet_owner_page_links_private: { p_slug: "x", p_title: "x", p_body: "x", p_links: [] },
  inlet_owner_text_withheld: { p_body: "x" },
  inlet_owner_linked_source_ids: { p_slug: "x", p_title: "x", p_body: "x", p_links: [] },
  inlet_owner_norm: { p: "x" },
  trg_inlet_owner_wiki_guard: {},
  inlet_owner_default: {},
};
out.rpc = {};
for (const [door, base] of [["postgrest", PGRST], ["rest", `${OB}/rest/v1`]]) {
  if (!base) continue;
  for (const [fn, body] of Object.entries(calls)) {
    const r = await fetch(`${base}/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json", apikey: "local-trust" }, body: JSON.stringify(body) });
    await r.text();
    out.rpc[`${door}:${fn}`] = r.status;
  }
  // the private tables and the owner record, read directly
  for (const tb of ["inlet_owner", "inlet_private_sources", "inlet_owner_archive", "inlet_owner_withheld_chunks", "inlet_private_jobs", "inlet_private_job_events"]) {
    const r = await fetch(`${base}/${tb}?select=*&limit=1`, { headers: { apikey: "local-trust" } });
    const t = await r.text();
    out.rpc[`${door}:table:${tb}`] = r.status === 200 ? (t.trim() === "[]" ? 200 : 299) : r.status;   // 299 = rows returned
  }
  // the prune's view: readable (the owner's gmail thoughts) but it names no owner
  const v = await fetch(`${base}/inlet_owner_mail?limit=1`, { headers: { apikey: "local-trust" } });
  const vt = await v.text();
  out.rpc[`${door}:view`] = v.status;
  out.rpc[`${door}:view-has-owner-column`] = /"user_id"|owner/.test(vt);
}
console.log("PROBE " + JSON.stringify(out));
