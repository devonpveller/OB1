// wiki-withheld-probe.mjs - lab probe for rw-idea-privacy round 4 (review R1), run by run-workspace-tests.ps1 [5j]
// in a node container on the lab's internal network, against the lab's PostgREST (OPEN_BRAIN_URL), with slot 380's
// guard on. It drives the REAL wiki writer and reconcile (SHARED = a recipes/_shared directory: the base's or this
// change's) the way a compile does: one page that links an idea (IDEA_LINK, an archived idea thought's leaf) and one
// clean page, written into the lab vault (WIKI_GIT_DIR), then finishWikiPages(); then a reconcile check, and the lab
// viewer's /__health drift before and after its next periodic pass. Prints one JSON line: PROBE {...} (no text).
// Never point it at a live stack.
const SHARED = process.env.SHARED || "/shared";
const VIEWER = (process.env.PROBE_VIEWER || "").replace(/\/+$/, "");
const tag = process.env.PROBE_TAG || "probe";
const idea = process.env.IDEA_LINK || "";
if (!idea) { console.log("PROBE " + JSON.stringify({ error: "IDEA_LINK is not set" })); process.exit(2); }
const fs = await import("node:fs");
const path = await import("node:path");
const wp = await import(path.join(SHARED, "wiki-pages.mjs"));
const rc = await import(path.join(SHARED, "reconcile-wiki-pages.mjs"));
const vault = process.env.WIKI_GIT_DIR;
const dir = path.join(vault, "content", "topic");
fs.mkdirSync(dir, { recursive: true });
const guardedSlug = `content/topic/r1-guarded-${tag}`, cleanSlug = `content/topic/r1-clean-${tag}`;
const guardedFile = path.join(vault, `${guardedSlug}.md`), cleanFile = path.join(vault, `${cleanSlug}.md`);

async function driftNow() {
  if (!VIEWER) return null;
  try {
    const r = await fetch(`${VIEWER}/__health`);
    const t = await r.text();
    const m = /drift (\d+)/.exec(t);
    return { status: r.status, drift: m ? Number(m[1]) : 0 };
  } catch (e) { return { status: 0, error: String(e?.message || e) }; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = Number(process.env.PROBE_WAIT_MS || "12000"); // > the lab viewer's periodic reconcile (5 s)

const before = await driftNow();
wp.writeWikiPage(guardedFile, `---\ntitle: R1 guarded ${tag}\n---\nA compiled entity page citing [[${idea}]] among others.\n`);
wp.writeWikiPage(cleanFile, `---\ntitle: R1 clean ${tag}\n---\nA compiled page with shared text only.\n`);
const exitCode = await wp.finishWikiPages(`r1-probe-${tag}`);
const rows = await rc.listRows();
const report = await rc.reconcile({ vault, repair: false, log: () => {} });
await sleep(wait);
const after = await driftNow();
console.log("PROBE " + JSON.stringify({
  tag,
  exitCode,
  guardedFile: fs.existsSync(guardedFile), guardedRow: rows.has(guardedSlug),
  cleanFile: fs.existsSync(cleanFile), cleanRow: rows.has(cleanSlug),
  unsynced: wp.unsyncedWikiPages().length,
  reconcileMissingGuarded: report.missing.includes(guardedSlug),
  reconcileWithheld: report.withheld ?? null,
  healthBefore: before, healthAfter: after,
}));
