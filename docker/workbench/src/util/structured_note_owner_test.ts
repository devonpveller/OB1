// deno test src/util/structured_note_owner_test.ts - rw-note-slug-owner: two writers' structured notes with the same
// notebook and title never share a stored path (so the wiki_pages ON CONFLICT (slug) overwrite never fires across
// writers), and the stored path's SHAPE does not depend on whether anyone else holds the name.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { structuredNoteFileSlug, structuredNoteStoredSlug } from "./structured-note-check.ts";

// A stand-in for the vault + wiki_pages: one slot per stored slug, written the way syncNoteRow does (upsert by slug).
async function save(store: Map<string, string>, nb: string, titleSlug: string, sub: string, text: string): Promise<string> {
  const slug = await structuredNoteStoredSlug(nb, titleSlug, sub);
  store.set(slug, text);
  return slug;
}

Deno.test("two identities, same notebook and title: both notes survive, two slots", async () => {
  for (const t of ["idea", "nb", "nb-note"]) {
    const s = new Map<string, string>();
    const a = await save(s, "nb", t, "sub-A", "X");
    const b = await save(s, "nb", t, "sub-B", "Y");
    assertNotEquals(a, b);
    assertEquals(s.size, 2);
    assertEquals([s.get(a), s.get(b)], ["X", "Y"]);
  }
});

Deno.test("the same writer saving again replaces only their own note", async () => {
  const s = new Map<string, string>();
  const a = await save(s, "nb", "idea", "sub-A", "X");
  const b = await save(s, "nb", "idea", "sub-B", "Y");
  assertEquals(await save(s, "nb", "idea", "sub-A", "X2"), a);
  assertEquals([s.size, s.get(a), s.get(b)], [2, "X2", "Y"]);
});

Deno.test("no oracle: the stored slug is a function of (notebook, title, writer) alone and has one shape for everyone", async () => {
  const alone = new Map<string, string>();
  const held = new Map<string, string>();
  await save(held, "nb", "idea", "sub-A", "X");
  const p1 = await save(alone, "nb", "idea", "sub-B", "Y");
  const p2 = await save(held, "nb", "idea", "sub-B", "Y");
  assertEquals(p1, p2, "B's path is the same whether or not A holds the name");
  for (const sub of ["sub-A", "sub-B", "", "x".repeat(300)]) {
    assert(/^idea-[0-9a-f]{8}$/.test(await structuredNoteStoredSlug("nb", "idea", sub)), "one shape: <slug>-<8 hex>");
  }
  // the writer's subject itself is not readable from the path
  assert(!(await structuredNoteStoredSlug("nb", "idea", "sub-A")).includes("sub-A"));
});

Deno.test("the hub rule is unchanged: a title equal to the notebook still goes to <nb>-note, then gains the writer tag", async () => {
  assert((await structuredNoteStoredSlug("nb", "nb", "sub-A")).startsWith(`${structuredNoteFileSlug("nb", "nb")}-`));
  assertNotEquals(await structuredNoteStoredSlug("nb", "nb", "sub-A"), "nb");
});

Deno.test("writeStructuredNote builds its path through the owner rule", async () => {
  let repo: string;
  try {
    repo = (await Deno.readTextFile(new URL("../repositories/notes.ts", import.meta.url))).replace(/\r\n/g, "\n");
  } catch {
    return;
  }
  const w = repo.slice(repo.indexOf("export async function writeStructuredNote("));
  const fnBody = w.slice(0, w.indexOf("\n}\n"));
  assert(fnBody.includes("await structuredNoteStoredSlug(nbSlug, slugifyNotebook(input.title) || \"note\", input.authorSub ?? \"\")"));
  assert(fnBody.includes("const rel = `content/notebooks/${nbSlug}/${fileSlug}.md`;"));
});
