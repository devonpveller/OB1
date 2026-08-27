// deno test — pure gate for the note→wiki_pages row derivation (Phase B).
import { assertEquals } from "jsr:@std/assert@1";
import { parseNoteRow } from "../repositories/notes.ts";

Deno.test("parseNoteRow: frontmatter title + body split", () => {
  const r = parseNoteRow("notes/a/b.md", '---\ntitle: "My Note"\nsource: user_note\n---\n\nbody text\n');
  assertEquals(r.slug, "notes/a/b");
  assertEquals(r.title, "My Note");
  assertEquals(r.body.includes("body text"), true);
  assertEquals(r.body.includes("title:"), false);
});

Deno.test("parseNoteRow: no frontmatter, CRLF, title fallback", () => {
  const r = parseNoteRow("notes/plain.md", "just text");
  assertEquals(r.title, "plain");
  assertEquals(r.body, "just text");
  const c = parseNoteRow("notes/c.md", "---\r\ntitle: C\r\n---\r\n\r\nx\r\n");
  assertEquals(c.title, "C");
  assertEquals(c.body.includes("title"), false);
});
