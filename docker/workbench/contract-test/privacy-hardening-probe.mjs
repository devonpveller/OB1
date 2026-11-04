// privacy-hardening-probe.mjs - lab probe for rw-privacy-hardening, run by run-privacy-hardening-lab.ps1 in a node
// container on the lab's internal network against the lab's PostgREST (OPEN_BRAIN_URL). It drives the REAL wiki writer
// (SHARED = a recipes/_shared directory: the base's or this change's) the way a compile does, and the note save the
// workbench does. Prints one JSON line: PROBE {...} - slugs, booleans and the refusal MESSAGES (no idea text).
// Never point it at a live stack.
//   IDEA_THOUGHT  the id of an archived idea thought (slot 380)      REPORT_SOURCE  the id of a moved report (slot 390)
//   TAG           a run tag for the slugs
const SHARED = process.env.SHARED || "/shared";
const OB = (process.env.OPEN_BRAIN_URL || "").replace(/\/+$/, "");
const tag = process.env.TAG || "t";
const th = process.env.IDEA_THOUGHT || "";
const rs = process.env.REPORT_SOURCE || "";
if (!th || !OB) { console.log("PROBE " + JSON.stringify({ error: "IDEA_THOUGHT / OPEN_BRAIN_URL not set" })); process.exit(2); }
const fs = await import("node:fs");
const path = await import("node:path");
const wp = await import(path.join(SHARED, "wiki-pages.mjs"));
const vault = process.env.WIKI_GIT_DIR;
const dir = path.join(vault, "content", "topic");
fs.mkdirSync(dir, { recursive: true });
const page = (title, body) => `---\ntitle: ${title}\n---\n${body}\n`;
const file = (n) => path.join(dir, `ph-${n}-${tag}.md`);
const slug = (n) => `content/topic/ph-${n}-${tag}`;
async function rowsNow(names) {
  const list = names.map((n) => `"${slug(n)}"`).join(",");
  const r = await fetch(`${OB}/rest/v1/wiki_pages?select=slug&slug=in.(${encodeURIComponent(list)})`, { headers: { apikey: "local-trust" } });
  return new Set((await r.json()).map((x) => x.slug));
}
const out = { tag };

// 1. the link forms the guard must withhold (380: case-insensitive, %2F decoded) and the controls it must not
const forms = {
  "link-upper": `A compiled page citing [[Thought/${th}]] among others.`,
  "link-lower": `A compiled page citing [[thought/${th}]] among others.`,
  "link-enc": `A compiled page citing the leaf thought%2F${th} among others.`,
  "link-enc-upper": `A compiled page citing the leaf (THOUGHT%2f${th}) among others.`,
  "ctl-after": `A compiled page about afterthought/${th} (not a link).`,
  "ctl-longer": `A compiled page about thought/${th}0 (another thought).`,
  "ctl-clean": `A compiled page with shared text only.`,
};
for (const [n, body] of Object.entries(forms)) wp.writeWikiPage(file(n), page(`PH ${n} ${tag}`, body));
out.exit1 = await wp.finishWikiPages(`ph-${tag}`);
const have = await rowsNow(Object.keys(forms));
out.rows = Object.fromEntries(Object.keys(forms).map((n) => [n, have.has(slug(n))]));
out.files = Object.fromEntries(Object.keys(forms).map((n) => [n, fs.existsSync(file(n))]));
out.unsynced1 = wp.unsyncedWikiPages().length;

// 2. the marker: a raw upsert of one guarded page - the answer's X-Wiki-Withheld count (PostgREST returns what the
// guard set in response.headers)
{
  const row = { slug: slug("raw-guarded"), page_class: "entity", title: "raw", body: `see [[Thought/${th}]]`, tags: [], links: [], frontmatter: {} };
  const r = await fetch(`${OB}/rest/v1/wiki_pages?on_conflict=slug&select=slug`, { method: "POST",
    headers: { "content-type": "application/json", apikey: "local-trust", prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify([row, { ...row, slug: slug("raw-clean"), body: "shared" }]) });
  out.marker = { status: r.status, header: r.headers.get("x-wiki-withheld"), back: (await r.json()).map((x) => x.slug).sort() };
}

// 3. a row that is missing from the answer although NO guard withheld it (the lab's stand-in: a trigger that silently drops a
// slug): it is HIDDEN, not withheld - its file must stay, the page is unsynced, the run fails
const oldText = page(`PH hidden old ${tag}`, "A page that was already there.");
fs.writeFileSync(file("hidden-old"), oldText);
wp.writeWikiPage(file("hidden"), page(`PH hidden ${tag}`, "A page the database does not return and no guard reports."));
wp.writeWikiPage(file("hidden-old"), page(`PH hidden old ${tag}`, "New text for a row the database does not return."));
out.exit2 = await wp.finishWikiPages(`ph-hidden-${tag}`);
out.hidden = { file: fs.existsSync(file("hidden")), row: (await rowsNow(["hidden"])).has(slug("hidden")),
  unsynced: wp.unsyncedWikiPages().some((x) => x.slug === slug("hidden")), withheldMemo: wp.isWithheldWikiPage(slug("hidden")),
  oldKept: fs.existsSync(file("hidden-old")) && fs.readFileSync(file("hidden-old"), "utf8") === oldText,
  staged: fs.readdirSync(dir).filter((f) => f.includes("wp-staged")).length };
// a mixed batch: one row a guard withheld (a link to the idea) and one the lab trigger drops - one header count (1) for two
// missing rows, so both are hidden and NEITHER file may be published
wp.writeWikiPage(file("hidden-mixed"), page(`PH hidden mixed ${tag}`, "Hidden by the lab trigger."));
wp.writeWikiPage(file("held-mixed"), page(`PH held mixed ${tag}`, `Withheld: [[thought/${th}]].`));
out.exit3 = await wp.finishWikiPages(`ph-mixed-${tag}`);
out.mixed = { heldFile: fs.existsSync(file("held-mixed")), hiddenFile: fs.existsSync(file("hidden-mixed")),
  staged: fs.readdirSync(dir).filter((f) => f.includes("wp-staged")).length };

// 4. R3: a NOTE that links an idea's thought, and a NOTE that cites a moved report: refused, with the same message that
// names neither
async function note(n, body) {
  const r = await fetch(`${OB}/rest/v1/wiki_pages?on_conflict=slug`, { method: "POST",
    headers: { "content-type": "application/json", apikey: "local-trust", prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ slug: `notes/ph-${n}-${tag}`, page_class: "note", title: "A note", body, tags: [], links: [], frontmatter: {} }]) });
  const t = await r.text();
  let m = ""; try { m = JSON.parse(t).message ?? ""; } catch { m = t.slice(0, 200); }
  return { status: r.status, message: m };
}
out.noteIdea = await note("idea", `my note links [[thought/${th}]]`);
if (rs) out.noteReport = await note("report", `my note cites [[content/source/${rs}]]`);
out.noteClean = await note("clean", "a note with nothing in it");
console.log("PROBE " + JSON.stringify(out));
