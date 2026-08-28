// PURE note parsing — no DB, no env, no imports outside this file.
//
// Lives in util/ (not repositories/) so it runs in the IMAGE BUILD test gate:
// the repositories layer imports "@shared/*" from the /recipes bind-mount,
// which only exists at runtime, so nothing importing it can be tested at
// build. That gap is how the 2026-08-28 lifecycle bugs shipped unseen.
//
// extractLinks deliberately MIRRORS recipes/_shared/links.mjs (the node
// compile pipeline's copy). Ten pure lines duplicated across a runtime
// boundary beats a cross-mount import that cannot be exercised at build —
// both copies carry unit tests with the same cases, so drift fails a build.

// Raw [[wikilink]] targets: alias and #anchor stripped, de-duplicated, order
// preserved, AS WRITTEN (resolution to full slugs is the repository's job).
export function extractLinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(body || "").matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = m[1].split("|")[0].split("#")[0].trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

// note file (vault-relative path + content) → its wiki_pages row fields.
export function parseNoteRow(
  rel: string,
  content: string,
): { slug: string; title: string; body: string; tags: string[]; rawLinks: string[] } {
  const slug = rel.replace(/\.md$/i, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  const body = m ? content.slice(m[0].length) : content;
  const t = m ? /^title:\s*(.*)$/m.exec(m[1]) : null;
  let title = t ? t[1].trim().replace(/^["']|["']$/g, "") : "";
  if (!title) title = slug.split("/").pop() ?? slug;
  // Inline-list frontmatter tags (`tags: [note, ai]`) — the only form our
  // writers emit.
  const tg = m ? /^tags:\s*\[([^\]]*)\]/m.exec(m[1]) : null;
  const tags = tg
    ? tg[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
    : [];
  return { slug, title, body, tags, rawLinks: extractLinks(body) };
}
