// deno test src/util/structured_note_check_test.ts - rw-570-hub-note-scope R5: a structured note quoting a private
// report is refused before anything is written (the database's answer is stubbed here; the slot 575 lab runs the
// real door, RED on the tip image and GREEN on the fix).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  assertNoteNamesFit,
  assertStructuredNoteShareable,
  MAX_SLUG_LEN,
  NOTE_NAME_TOO_LONG,
  writeGuardedStructuredNote,
  NOTE_CHECK_UNAVAILABLE,
  NOTE_QUOTES_PRIVATE_REPORT,
  StructuredNoteRefused,
  structuredNoteFileSlug,
  structuredNoteViews,
} from "./structured-note-check.ts";

const row = { slug: "content/notebooks/nb/a-note", title: "A note", body: "Some text." };

Deno.test("R5: a note the database says quotes a private report is refused 422 with the one message", async () => {
  const e = await assertRejects(() => assertStructuredNoteShareable(row, () => Promise.resolve(true)), StructuredNoteRefused);
  assertEquals([e.status, e.message], [422, NOTE_QUOTES_PRIVATE_REPORT]);
  assert(/private report/.test(NOTE_QUOTES_PRIVATE_REPORT) && /share the report first/.test(NOTE_QUOTES_PRIVATE_REPORT));
});

Deno.test("R5: a note without such a sentence passes; the database is asked about the row the write would store", async () => {
  const seen: string[][] = [];
  await assertStructuredNoteShareable(row, (s, t, b) => { seen.push([s, t, b]); return Promise.resolve(false); });
  assertEquals(seen, [[row.slug, row.title, row.body]]);
});

Deno.test("R5: no answer (null, or the check throws) refuses 503: nothing is saved (fail closed)", async () => {
  for (const ask of [() => Promise.resolve(null), () => Promise.reject(new Error("function does not exist"))]) {
    const e = await assertRejects(() => assertStructuredNoteShareable(row, ask), StructuredNoteRefused);
    assertEquals([e.status, e.message], [503, NOTE_CHECK_UNAVAILABLE]);
  }
});

Deno.test("R5: writeStructuredNote checks BEFORE the vault write and the row sync; the route maps the refusal to its status", async () => {
  let repo: string, route: string;
  try {
    repo = (await Deno.readTextFile(new URL("../repositories/notes.ts", import.meta.url))).replace(/\r\n/g, "\n");
    route = (await Deno.readTextFile(new URL("../routes/notes.ts", import.meta.url))).replace(/\r\n/g, "\n");
  } catch {
    return;
  }
  const w = repo.slice(repo.indexOf("export async function writeStructuredNote("));
  const fnBody = w.slice(0, w.indexOf("\n}\n"));
  const check = fnBody.indexOf("ask: askNoteRefusedPre(input.authorSub ?? \"\"),");
  assert(check > 0, "the pre-check reads the views (row, whole file, agent)");
  assert(fnBody.includes("structuredNoteViews({ slug: row.slug, title: row.title, body: row.body }, body, input.agent)"), "the agent line is judged with the content");
  assert(fnBody.includes("askAtWrite: askNoteRefused(input.authorSub ?? \"\"),"), "the check is made again at the row write, never the seam");
  assert(fnBody.includes("writeRow: () => syncNoteRow(rel, body, input.authorSub, true),"), "the row write is strict: a refusal is thrown, not swallowed");
  assert(fnBody.includes("else await vaultDelete(rel);"), "a refusal at the row write takes the vault file back out");
  assert(fnBody.includes("assertNoteNamesFit(nbSlug, fileSlug);"), "the length guard runs before any write");
  assert(fnBody.indexOf("assertNoteNamesFit(") < fnBody.indexOf("await writeGuardedStructuredNote("), "length guard first");
  assert(repo.includes("if (strict) throw e;"), "strict row sync rethrows");
  assert(fnBody.includes("const fileSlug = structuredNoteFileSlug(nbSlug, slugifyNotebook(input.title) || \"note\");"), "the file slug never takes the hub's");
  assert(fnBody.includes("writeFile: async () => { await vaultWrite(rel, body); },"), "the vault file is written inside the guarded sequence only");
  assert(!fnBody.replace("writeFile: async () => { await vaultWrite(rel, body); },", "").includes("vaultWrite(rel, body)") && !/\bawait syncNoteRow\(/.test(fnBody), "no unguarded vault write or row write");
  assert(fnBody.indexOf("await vaultCommit(") > check, "the commit comes after the guarded write");
  assert(repo.includes("SELECT public.private_report_claims_note_refused($1, $2, $3, $4) AS refused") && repo.includes("[authorSub, slug, title, body]"), "the database's answer for THIS writer (slot 575)");
  assert(route.includes("repo.writeStructuredNote({ ...body, authorSub: (await identityOf(c)).sub })"), "the writer is the verified identity, not a body field");
  assert(route.includes("if (e instanceof repo.StructuredNoteRefused) return c.json({ error: e.message }, e.status);"), "the route answers the refusal's status");
});

Deno.test("attempt 2: a structured note never takes its notebook's hub path; decided from the slugs alone", () => {
  assertEquals(structuredNoteFileSlug("my-notebook", "my-notebook"), "my-notebook-note", "title = notebook -> beside the hub, not on it");
  assertEquals(structuredNoteFileSlug("my-notebook", "a-note"), "a-note");
  assertEquals(structuredNoteFileSlug("my-notebook", "my-notebook-note"), "my-notebook-note");
  for (const nb of ["x", "notes", "index"]) assert(structuredNoteFileSlug(nb, nb) !== nb, `never ${nb}/${nb}`);
});

// attempt 3 (tester Case 6): a stand-in for the database's own-sentence predicate - the guard's joining (slug + title,
// then body) and a letters-only skeleton, as slot 570's normaliser compares
const skel = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, "");
const ownOf = (own: string[]) => (slug: string, title: string, body: string) =>
  Promise.resolve(own.some((o) => skel(`${slug} ${title} ${body}`).includes(skel(o))));

Deno.test("attempt 3: the writer's own sentence split across the title and the content is refused (the row view); another user's is not", async () => {
  const own = "The prcbx alpha result reproduced in twelve trials across two labs.";
  const title = "The prcbx alpha result";
  const content = "reproduced in twelve trials across two labs.";
  const file = `---\ntitle: ${JSON.stringify(title)}\nsource: user_note\nnotebook: "nb"\ntags: [note, ai]\n---\n${content}\n`;
  const row = { slug: "content/notebooks/nb/the-prcbx-alpha-result", title, body: `${content}\n` };
  // the whole-file view alone misses it (the frontmatter lines sit between the title and the content)
  assertEquals(await ownOf([own])(row.slug, row.title, file), false);
  const views = structuredNoteViews(row, file);
  assertEquals(views.map((v) => v.body), [row.body, file], "the row view first, then the whole file");
  const e = await assertRejects(() => assertStructuredNoteShareable(views, ownOf([own])), StructuredNoteRefused);
  assertEquals([e.status, e.message], [422, NOTE_QUOTES_PRIVATE_REPORT], "the writer's own split sentence: 422");
  await assertStructuredNoteShareable(views, ownOf([])); // another user's sentence (not the writer's own): saved
  // the whole-file view still catches a frontmatter field (F1)
  const agentFile = `---\ntitle: "t"\nsource: user_note\nagent: ${JSON.stringify(own)}\nnotebook: "nb"\n---\nclean\n`;
  await assertRejects(() => assertStructuredNoteShareable(structuredNoteViews({ slug: "content/notebooks/nb/t", title: "t", body: "clean\n" }, agentFile), ownOf([own])), StructuredNoteRefused);
  // a view with no answer refuses 503
  const e2 = await assertRejects(() => assertStructuredNoteShareable(views, () => Promise.resolve(null)), StructuredNoteRefused);
  assertEquals(e2.status, 503);
});

// ── rw-note-write-guard ──
const A_OWN = "The zorbik gamma assay reproduced across nine independent runs.";

Deno.test("write-guard split: A's own sentence split across agent and content is refused 422; B's split by A is saved", async () => {
  const first = "The zorbik gamma assay";
  const rest = "reproduced across nine independent runs.";
  const r = { slug: "content/notebooks/nb/t", title: "t", body: `${rest}\n` };
  const file = `---\ntitle: "t"\nsource: user_note\nagent: ${JSON.stringify(first)}\nnotebook: "nb"\n---\n${rest}\n`;
  // neither the row view nor the whole-file view sees agent next to the content
  const noAgent = structuredNoteViews(r, file);
  assertEquals(await Promise.all(noAgent.map((v) => ownOf([A_OWN])(v.slug, v.title, v.body))), [false, false], "RED without the agent view");
  const views = structuredNoteViews(r, file, first);
  const e = await assertRejects(() => assertStructuredNoteShareable(views, ownOf([A_OWN])), StructuredNoteRefused);
  assertEquals(e.status, 422);
  // the same split of B's sentence, written by A (A holds only A_OWN): saves
  const bViews = structuredNoteViews({ ...r, body: "persisted through every blinded rerun.\n" }, file, "A quillan delta signal");
  await assertStructuredNoteShareable(bViews, ownOf([A_OWN]));
  // title + agent + content as one run, and agent then title then content
  const tViews = structuredNoteViews({ slug: r.slug, title: "gamma assay", body: "reproduced across nine independent runs.\n" }, "x", "The zorbik");
  await assertRejects(() => assertStructuredNoteShareable(tViews, ownOf([A_OWN])), StructuredNoteRefused);
  const t2Views = structuredNoteViews({ slug: r.slug, title: "zorbik gamma", body: "assay reproduced across nine independent runs.\n" }, "x", "The");
  await assertRejects(() => assertStructuredNoteShareable(t2Views, ownOf([A_OWN])), StructuredNoteRefused);
  // no agent: the views are exactly the two as before
  assertEquals(structuredNoteViews(r, file, "  ").length, 2);
});

function throwsSync(f: () => void): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
}

Deno.test("write-guard length: a 300-letter notebook name is a 422 with one plain message, the same for every caller; a long normal name passes", () => {
  const nb = "n".repeat(300);
  for (let i = 0; i < 2; i++) {
    const err = throwsSync(() => assertNoteNamesFit(nb, "a-note"));
    assert(err instanceof StructuredNoteRefused);
    assertEquals([err.status, err.message], [422, NOTE_NAME_TOO_LONG]);
  }
  assert(throwsSync(() => assertNoteNamesFit("nb", "t".repeat(MAX_SLUG_LEN + 1))) instanceof StructuredNoteRefused);
  assertEquals(throwsSync(() => assertNoteNamesFit("n".repeat(80), "t".repeat(80))), undefined); // well under the limit
  assertEquals(throwsSync(() => assertNoteNamesFit("n".repeat(MAX_SLUG_LEN), "t".repeat(MAX_SLUG_LEN))), undefined);
});

// A scripted store: the vault file and the row, as the guarded sequence leaves them
function harness(opts: { pre: boolean | null; atWrite: boolean | null; rowErr?: Error; before?: string }) {
  const st = { file: opts.before ?? (null as string | null), row: false, calls: [] as string[] };
  const views = [{ slug: "s", title: "t", body: "b" }];
  return {
    st,
    run: () =>
      writeGuardedStructuredNote({
        views,
        ask: () => Promise.resolve(opts.pre),
        askAtWrite: () => Promise.resolve(opts.atWrite),
        writeFile: () => { st.calls.push("file"); st.file = "NEW"; return Promise.resolve(); },
        writeRow: () => { st.calls.push("row"); if (opts.rowErr) return Promise.reject(opts.rowErr); st.row = true; return Promise.resolve(); },
        undoFile: () => { st.calls.push("undo"); st.file = opts.before ?? null; return Promise.resolve(); },
      }),
  };
}

Deno.test("write-guard race: pre-check false, claim present at the row write -> A is 422, file absent, no row; B (no claim) saves", async () => {
  const a = harness({ pre: false, atWrite: true });
  const e = await assertRejects(() => a.run(), StructuredNoteRefused);
  assertEquals([e.status, e.message], [422, NOTE_QUOTES_PRIVATE_REPORT]);
  assertEquals([a.st.file, a.st.row, a.st.calls], [null, false, ["file", "undo"]]);
  const b = harness({ pre: false, atWrite: false });
  await b.run();
  assertEquals([b.st.file, b.st.row], ["NEW", true]);
});

Deno.test("write-guard race: the guard's own 42501 at the row write is 422 and takes the file out; an unanswered re-check is 503 and takes it out", async () => {
  const g = harness({ pre: false, atWrite: false, rowErr: Object.assign(new Error("new row violates row-level security policy"), { code: "42501" }) });
  const e = await assertRejects(() => g.run(), StructuredNoteRefused);
  assertEquals([e.status, e.message, g.st.file, g.st.row], [422, NOTE_QUOTES_PRIVATE_REPORT, null, false]);
  const u = harness({ pre: false, atWrite: null });
  const e2 = await assertRejects(() => u.run(), StructuredNoteRefused);
  assertEquals([e2.status, u.st.file, u.st.row], [503, null, false]);
  const d = harness({ pre: false, atWrite: false, rowErr: new Error("connection reset") });
  const e3 = await assertRejects(() => d.run(), StructuredNoteRefused);
  assertEquals([e3.status, d.st.file], [503, null]);
});

Deno.test("write-guard: a refusal at the row write puts back what the path held; a pre-check refusal writes nothing at all", async () => {
  const h = harness({ pre: false, atWrite: true, before: "PREVIOUS" });
  await assertRejects(() => h.run(), StructuredNoteRefused);
  assertEquals(h.st.file, "PREVIOUS");
  const p = harness({ pre: true, atWrite: true });
  await assertRejects(() => p.run(), StructuredNoteRefused);
  assertEquals(p.st.calls, [], "no file, no row, no undo");
});
