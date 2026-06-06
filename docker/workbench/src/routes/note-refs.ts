// /workbench/note-refs (P3.5 follow-up) — a note's dynamic reference list.
// A note's sources have TWO origins, kept distinct here:
//   • cited  — source leaves referenced in the body ([[…source/<uuid>…]])
//   • added  — sources the author deliberately attached (frontmatter `sources:`)
// GET resolves both to titles; POST/DELETE manage the deliberate `sources:` list
// in the note's frontmatter (write + vault commit — the G1 exception). On export
// the union is emitted as a clean "## References" list (origin dropped) — see
// routes/export.ts.
import { Hono } from "hono";
import { query } from "../db/pool.ts";
import { safeRelPath } from "../util/paths.ts";
import { vaultExists, vaultRead, vaultWrite, vaultCommit } from "../util/vault.ts";

export const noteRefs = new Hono();

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
// source leaves cited in the body: [[content/source/<uuid>|x]] or [[source/<uuid>]]
const BODY_SOURCE_RE = /\[\[[^\]]*source\/([0-9a-fA-F-]{36})/g;

function splitFrontmatter(content: string): { fm: string; body: string } {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) {
      const nl = content.indexOf("\n", end + 4);
      const fmEnd = nl === -1 ? content.length : nl + 1;
      return { fm: content.slice(0, fmEnd), body: content.slice(fmEnd) };
    }
  }
  return { fm: "", body: content };
}

function readAddedSources(fm: string): string[] {
  const m = fm.match(/^sources:\s*\[([^\]]*)\]\s*$/m);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => UUID_RE.test(s));
}

// Rewrite the note with `sources: [...]` set to `uuids` (kept keys in order,
// sources appended; removed when empty). One blank line before the body.
function writeAddedSources(content: string, uuids: string[]): string {
  const { fm, body } = splitFrontmatter(content);
  const inner = fm ? fm.replace(/^---\r?\n/, "").replace(/\r?\n?---\r?\n?$/, "") : "";
  const kept = inner.split(/\r?\n/).filter((l) => l.trim() !== "" && !/^sources:\s*\[/.test(l));
  if (uuids.length) kept.push("sources: [" + uuids.join(", ") + "]");
  const newFm = "---\n" + kept.join("\n") + "\n---\n\n";
  return newFm + body.replace(/^\n+/, "");
}

async function resolve(uuids: string[]): Promise<unknown[]> {
  if (!uuids.length) return [];
  const rows = await query<{ id: string; title: string; url: string; content_type: string }>(
    `SELECT id::text AS id, title, url, content_type FROM public.sources WHERE id = ANY($1::uuid[])`,
    [uuids],
  ).catch(() => []);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return uuids.map((u) => byId.get(u)).filter(Boolean) as unknown[];
}

function notePath(c: { req: { query: (k: string) => string | undefined } }): string {
  const raw = c.req.query("path") || "";
  const rel = safeRelPath(raw);
  if (!rel.startsWith("notes/") || !rel.endsWith(".md")) throw new Error("path must be a notes/*.md file");
  return rel;
}

// Gather added (frontmatter) + cited (body links), resolved + de-duplicated.
async function gather(content: string) {
  const { fm, body } = splitFrontmatter(content);
  const added = readAddedSources(fm);
  const addedSet = new Set(added);
  const cited: string[] = [];
  let m: RegExpExecArray | null;
  BODY_SOURCE_RE.lastIndex = 0;
  while ((m = BODY_SOURCE_RE.exec(body))) {
    const u = m[1];
    if (!addedSet.has(u) && !cited.includes(u)) cited.push(u);
  }
  return { added: await resolve(added), cited: await resolve(cited) };
}

// GET /workbench/note-refs?path=notes/...md
noteRefs.get("/", async (c) => {
  let rel: string;
  try {
    rel = notePath(c);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
  if (!(await vaultExists(rel))) return c.json({ error: "note not found" }, 404);
  return c.json(await gather(await vaultRead(rel)));
});

// POST /workbench/note-refs?path=... { source_id } — deliberately add a source.
noteRefs.post("/", async (c) => {
  let rel: string;
  try {
    rel = notePath(c);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const sourceId = (body?.source_id ?? "").toString();
  if (!UUID_RE.test(sourceId)) return c.json({ error: "source_id must be a uuid" }, 400);
  if (!(await vaultExists(rel))) return c.json({ error: "note not found" }, 404);
  const content = await vaultRead(rel);
  const added = readAddedSources(splitFrontmatter(content).fm);
  if (!added.includes(sourceId)) {
    added.push(sourceId);
    await vaultWrite(rel, writeAddedSources(content, added));
    await vaultCommit(`note-refs: add source to ${rel}`);
  }
  return c.json(await gather(await vaultRead(rel)), 201);
});

// DELETE /workbench/note-refs?path=...&source_id=... — remove a deliberate add.
noteRefs.delete("/", async (c) => {
  let rel: string;
  try {
    rel = notePath(c);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
  const sourceId = (c.req.query("source_id") || "").toString();
  if (!(await vaultExists(rel))) return c.json({ error: "note not found" }, 404);
  const content = await vaultRead(rel);
  const added = readAddedSources(splitFrontmatter(content).fm).filter((u) => u !== sourceId);
  await vaultWrite(rel, writeAddedSources(content, added));
  await vaultCommit(`note-refs: remove source from ${rel}`);
  return c.json(await gather(await vaultRead(rel)));
});
