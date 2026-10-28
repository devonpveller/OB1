// `create document` = PROMOTE (research-workbench P2b, D17 item 5): seed a user document from an
// idea. The draft is composed from what the idea accreted - its statement and revisions, its dossier,
// its sessions and what they produced - and every source, claim and page it drew on lands as a P2a
// reference row the document holds, pinned to the revision current now:
//   a source (incl. a held user source)  -> a [[source:<id>]] link; the listing places its
//                                           whole-source record (the document defines the pin)
//   a page                               -> a page is the leaf of a source here (content/source/<id>),
//                                           so its source's record stands for it
//   a claim                              -> [[claim:<id>]] and a chip on the report it was parsed
//                                           from, quoting the claim where the report states it
//   the dossier                          -> a transclusion of its opening, pinned
// The seed is composed, not generated: no model is called (all inference would go through LiteLLM
// with its own key, and nothing in the acceptance needs one). The document is then an ordinary user
// document (D12: authored, outbound links only, never ingested); the idea moves to `promoted`, and
// the refinery is tethered to this, its one document.
import type { Db } from "../contracts/db.ts";
import type { RegistryReader } from "../contracts/registry.ts";
import { idea as readIdea } from "../contracts/repo/ideas.ts";
import { placeReference } from "../contracts/repo/references.ts";
import { chipText, transclusionText } from "./grammar.ts";
import { syncListing } from "./listing.ts";
import { createDocument, DocError } from "./repo.ts";
import { HOLDER_KIND } from "./paths.ts";
import type { Identity } from "../middleware/identity.ts";
import { vaultRead, vaultWrite, vaultCommitPath } from "../util/vault.ts";

const DOSSIER_OPENING = 600;

function opening(text: string): string {
  const t = text.trim();
  if (t.length <= DOSSIER_OPENING) return t;
  const cut = t.lastIndexOf(" ", DOSSIER_OPENING);
  return t.slice(0, cut > DOSSIER_OPENING / 2 ? cut : DOSSIER_OPENING);
}

const esc = (s: string) => s.replace(/[\]|\n]/g, " ").trim();

export async function seedFromIdea(db: Db, reg: RegistryReader, ideaId: string, who: Identity, opts: { folder?: string } = {}) {
  const idea = await readIdea(db, ideaId, who.sub); // another user's idea answers like none
  if (!idea) throw new DocError("no idea with this id", 404);
  if (idea.refinery.members.document) {
    throw new DocError("this refinery already has its document - go to document", 409, { path: idea.refinery.members.document.path });
  }
  const held = idea.refinery.user_sources.filter((u) => u.state === "held");
  const sources = [...idea.produced.sources.filter((s) => s.id !== idea.dossier?.source_id), ...held.map((h) => ({ id: h.source_id, title: h.title }))];
  const created = await createDocument({ db, reg }, {
    title: idea.title, folder: opts.folder,
    fields: { idea: idea.summary, seeded_from: idea.id },
    body: "_Seeded from the idea's accreted work (create document); it is yours to edit._\n\n",
  }, who);
  const rel = created.path;
  const holder = { kind: HOLDER_KIND, ref: rel, origin: "cited" };
  const parts: string[] = [];
  parts.push("## The idea\n", idea.summary || "(no statement yet)", "");
  if (idea.revisions.length > 1) {
    parts.push("## How it developed\n", ...idea.revisions.map((r) => `- revision ${r.revision}: ${r.summary.replace(/\n+/g, " ")}`), "");
  }
  if (idea.dossier) {
    const text = (await db.query<{ content: string }>(`SELECT content FROM public.sources WHERE id = $1`, [idea.dossier.source_id]))[0]?.content ?? "";
    const exact = opening(text);
    const placed = exact
      ? await placeReference(db, reg, { source_id: idea.dossier.source_id, exact, holder, by: "seed" })
      : await placeReference(db, reg, { source_id: idea.dossier.source_id, holder, by: "seed" });
    parts.push("## Dossier\n", `**${esc(idea.dossier.title)}**`, "", exact ? transclusionText(placed.record.id, exact) : chipText(placed.record.id), "");
  }
  if (idea.sessions.length) {
    parts.push("## Sessions\n", ...idea.sessions.map((s) => `- ${s.query.replace(/\n+/g, " ").slice(0, 200)} (${s.status})`), "");
  }
  if (idea.produced.claims.length) {
    parts.push("## Claims\n");
    for (const c of idea.produced.claims) {
      const report = (await db.query<{ synthesis_id: string | null; content: string | null }>(
        `SELECT c.synthesis_id::text AS synthesis_id, s.content FROM public.claims c LEFT JOIN public.sources s ON s.id = c.synthesis_id WHERE c.id = $1`,
        [c.id],
      ))[0];
      let chip = "";
      if (report?.synthesis_id) {
        const quoted = (report.content ?? "").includes(c.text);
        const placed = await placeReference(db, reg, {
          source_id: report.synthesis_id, exact: quoted ? c.text : null, holder, by: "seed",
        });
        chip = ` ${chipText(placed.record.id)}`;
      }
      parts.push(`- ${c.text.replace(/\n+/g, " ")} [[claim:${c.id}|claim]]${chip}`);
    }
    parts.push("");
  }
  if (sources.length) {
    parts.push("## Sources\n", ...sources.map((s) => `- [[source:${s.id}|${esc(s.title || s.id)}]]`), "");
  }
  const content = (await vaultRead(rel)) + parts.join("\n");
  await vaultWrite(rel, content);
  await db.tx(async (t) => {
    await t.query(`UPDATE public.user_document_listings SET refinery_id = $1 WHERE path = $2`, [idea.id, rel]);
    await t.query(
      `INSERT INTO public.refinery_state (refinery_id, origin_kind) VALUES ($1, 'captured_idea') ON CONFLICT (refinery_id) DO NOTHING`,
      [idea.id],
    );
    await t.query(`UPDATE public.ideas SET status = 'promoted', updated_at = now() WHERE id = $1`, [idea.id]);
  });
  const listed = await syncListing(db, reg, rel, content, who, "seed");
  await vaultCommitPath(rel, `documents: seed ${rel} from idea ${idea.id}`, who.name);
  return { path: rel, refinery_id: idea.id, links: listed.links };
}
