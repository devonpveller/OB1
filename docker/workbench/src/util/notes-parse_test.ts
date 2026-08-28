// deno test — pure gate for the note→wiki_pages row derivation (Phase B).
// Lives in util/ so it runs at IMAGE BUILD (repositories/ imports the
// /recipes runtime mount and cannot be imported there).
import { assertEquals } from "jsr:@std/assert@1";
import { parseNoteRow } from "./notes-parse.ts";

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

Deno.test("parseNoteRow: inline frontmatter tags are parsed, quotes stripped", () => {
  const r = parseNoteRow("notes/t.md", '---\ntitle: T\ntags: [note, "ai", research]\n---\n\nx\n');
  assertEquals(r.tags, ["note", "ai", "research"]);
  assertEquals(parseNoteRow("notes/t.md", "no fm").tags, []);
});

Deno.test("parseNoteRow: raw wikilinks extracted from the body, alias/anchor stripped", () => {
  const r = parseNoteRow(
    "notes/t.md",
    "---\ntitle: T\n---\n\nsee [[tool-postgresql|pg]] and [[topic/x#sec]] and [[tool-postgresql]]\n",
  );
  assertEquals(r.rawLinks, ["tool-postgresql", "topic/x"]);
});
