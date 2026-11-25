// deno test src/util/structured_note_check_test.ts - rw-570-hub-note-scope R5: a structured note quoting a private
// report is refused before anything is written (the database's answer is stubbed here; the slot 575 lab runs the
// real door, RED on the tip image and GREEN on the fix).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  assertStructuredNoteShareable,
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
  const check = fnBody.indexOf("await assertStructuredNoteShareable(structuredNoteViews({ slug: row.slug, title: row.title, body: row.body }, body), askNoteRefused(input.authorSub ?? \"\"));");
  assert(check > 0, "the check reads the row exactly as the guard judges it AND the whole file");
  assert(fnBody.includes("const fileSlug = await structuredNoteStoredSlug(nbSlug, slugifyNotebook(input.title) || \"note\", input.authorSub ?? \"\");"), "the file slug never takes the hub's (structuredNoteStoredSlug wraps structuredNoteFileSlug)");
  assert(check < fnBody.indexOf("await vaultWrite(rel, body);") && check < fnBody.indexOf("await syncNoteRow(rel, body, input.authorSub);"), "before the vault file and the row");
  assert(fnBody.includes("await syncNoteRow(rel, body, input.authorSub);"), "the row names its writer (the guard judges it author-only, as the check)");
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
