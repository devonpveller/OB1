// /workbench/documents - the documents API (research-workbench P2b, D12) - and /workbench/workspace,
// the workspace's own small surface (who the user is, the bell's per-user read state).
//
// A user document is a vault file under documents/<owner>/ plus a body-less listing record; it is
// never a wiki page and never a contract page. The routes are thin: the logic is src/documents/.
// WHO the user is comes from the identity seam alone (src/middleware/identity.ts, identityOf): every
// route acts for that identity, on that user's documents only.
// Literal paths are registered before any wildcard (Hono matches in registration order).
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../contracts/db.ts";
import type { RegistryReader } from "../contracts/registry.ts";
import { Conflict, NotFound } from "../contracts/repo/lifecycle.ts";
import { placeReference, SelectorRefused } from "../contracts/repo/references.ts";
import { type Identity, identityConfig, identityOf, resolveIdentity } from "../middleware/identity.ts";
import * as docs from "../documents/repo.ts";
import * as refinery from "../documents/refinery.ts";
import { candidates } from "../documents/candidates.ts";
import { hubContext } from "../documents/hub.ts";
import { seedFromIdea } from "../documents/seed.ts";
import { syncListing } from "../documents/listing.ts";
import { chipText, transclusionText } from "../documents/grammar.ts";
import { HOLDER_KIND } from "../documents/paths.ts";
import { acknowledge, acknowledged } from "../documents/workspace.ts";
import { vaultExists, vaultRead } from "../util/vault.ts";

export type DocumentsDeps = refinery.RefineryDeps;

async function body(c: Context): Promise<Record<string, unknown>> {
  return await c.req.json().catch(() => ({})) as Record<string, unknown>;
}

const str = (v: unknown) => (v == null ? "" : String(v));

function fail(c: Context, e: unknown) {
  if (e instanceof docs.DocError) return c.json({ error: e.message, ...e.detail }, e.status);
  if (e instanceof NotFound) return c.json({ error: e.message }, 404);
  if (e instanceof Conflict) return c.json({ error: e.message, ...(e.detail as Record<string, unknown> ?? {}) }, 409);
  if (e instanceof SelectorRefused) return c.json({ error: e.message }, 422);
  const msg = String((e as Error)?.message ?? e);
  if (/path traversal|empty path|invalid path|a user document is a \.md|invalid folder/.test(msg)) return c.json({ error: msg }, 400);
  console.error("[documents] error:", msg);
  return c.json({ error: "internal" }, 500);
}

// every handler gets the request's identity from the seam
const wrap = (fn: (c: Context, who: Identity) => Promise<Response>) => async (c: Context) => {
  try {
    return await fn(c, await identityOf(c));
  } catch (e) {
    return fail(c, e);
  }
};

async function relist(db: Db, reg: RegistryReader, rel: string, who: Identity) {
  if (await vaultExists(rel)) await syncListing(db, reg, rel, await vaultRead(rel), who, who.name);
}

export function documentsRouter(rdeps: DocumentsDeps) {
  const { db, reg } = rdeps;
  const deps = { db, reg };
  const r = new Hono();

  // ── the file ────────────────────────────────────────────────────────────────────────────
  r.get("/file", wrap(async (c, who) => c.json(await docs.readDocument(deps, str(c.req.query("path")), who))));

  r.put("/file", wrap(async (c, who) => {
    const b = await body(c);
    const ifMatch = (b.if_match as string | undefined) ?? c.req.header("If-Match") ?? null;
    const out = await docs.saveDocument(deps, str(c.req.query("path")), str(b.content), ifMatch, who, { commit: c.req.query("commit") === "1" });
    // a listing that could not be updated is REPORTED (never a silent 200): 207, named in the body
    return c.json(out, out.listing.ok ? 200 : 207);
  }));

  r.post("/", wrap(async (c, who) => {
    const b = await body(c);
    const out = await docs.createDocument(deps, {
      title: str(b.title), folder: str(b.folder), body: str(b.body), fields: b.idea ? { idea: str(b.idea) } : {},
    }, who);
    return c.json(out, out.listing.ok ? 201 : 207);
  }));

  r.get("/state", wrap(async (c, who) => c.json(await docs.documentState(deps, str(c.req.query("path")), who))));
  // the default identity's pass also repairs the documents written before P2b at the tree's root
  r.post("/reconcile", wrap(async (c, who) =>
    c.json(await docs.reconcile(deps, who, { legacyRoot: who.sub === identityConfig().defaultSub }))));

  // ── folders and management ──────────────────────────────────────────────────────────────
  r.get("/folders", wrap(async (c, who) => c.json(await docs.folders(who))));
  r.post("/folders", wrap(async (c, who) => {
    const out = await docs.createFolder(str((await body(c)).path), who);
    return c.json(out, out.created ? 201 : 200);
  }));
  r.delete("/folders", wrap(async (c, who) => c.json(await docs.deleteFolder(deps, str((await body(c)).path || c.req.query("path")), who))));
  r.post("/move", wrap(async (c, who) => {
    const b = await body(c);
    return c.json(await docs.moveDocument(deps, str(b.from), str(b.to_folder), (b.if_match as string) ?? null, who));
  }));
  r.post("/trash", wrap(async (c, who) => c.json(await docs.trashDocument(deps, str((await body(c)).path), who))));
  r.post("/restore", wrap(async (c, who) => c.json(await docs.restoreDocument(deps, str((await body(c)).path), who))));
  r.post("/archive", wrap(async (c, who) => {
    const path = str((await body(c)).path);
    // archiving the document archives its refinery with it (D17 archive)
    const ref = await refinery.archiveRefinery(rdeps, path, who).catch((e) => {
      if (e instanceof docs.DocError && e.status === 409) return { refinery_id: null, archived: false };
      throw e;
    });
    return c.json({ ...(await docs.archiveDocument(deps, path, who)), refinery: ref });
  }));
  r.get("/history", wrap(async (c, who) => c.json(await docs.history(deps, str(c.req.query("path")), who))));
  r.post("/recover", wrap(async (c, who) => {
    const b = await body(c);
    return c.json(await docs.recoverDocument(deps, str(b.path), str(b.from), who));
  }));
  r.post("/property", wrap(async (c, who) => {
    const b = await body(c);
    const value = b.value === null ? null : str(b.value);
    return c.json(await docs.setProperty(deps, str(b.path), str(b.key), value, (b.if_match as string) ?? null, who));
  }));

  // ── references the document holds (P2a records - shared knowledge, held by this document) ─
  // form: "chip" (a citation at the cursor - inject), "transclusion" (protected quoted text), "added"
  // (attached deliberately, not in the text). The record pins the source's current revision.
  r.post("/references", wrap(async (c, who) => {
    const b = await body(c);
    const rel = await docs.ownedPath(db, str(b.path), who);
    const form = str(b.form) || "chip";
    if (!["chip", "transclusion", "added"].includes(form)) return c.json({ error: "form is chip, transclusion or added" }, 400);
    const placed = await placeReference(db, reg, {
      source_id: str(b.source_id), exact: b.exact ? str(b.exact) : null,
      near_chunk: typeof b.chunk_idx === "number" ? b.chunk_idx : null,
      holder: { kind: HOLDER_KIND, ref: rel, origin: form === "added" ? "added" : "cited" }, by: who.name,
    });
    const rec = placed.record;
    const quote = (rec.selectors as { quote?: { exact?: string } }).quote?.exact ?? "";
    if (form === "added") await relist(db, reg, rel, who);
    return c.json({
      record: rec, form,
      insert: form === "transclusion" ? transclusionText(rec.id, quote) : form === "chip" ? chipText(rec.id) : null,
    }, 201);
  }));

  r.get("/references", wrap(async (c, who) => {
    const rel = await docs.ownedPath(db, str(c.req.query("path")), who);
    // research-workbench P6b (rw-p6b-gate, acceptance 2: the export's reference list matches this panel
    // one-to-one): a reference is titled as the EXPORT prints it - the metadata its identifier resolved
    // to (P6a's cache on the reference record), else the source's title at the PINNED revision, else the
    // source's (or held source's) current title. Before P6b the panel showed the current title, so a
    // source retitled after the pin read differently on screen and in the file.
    const rows = await db.query(
      `SELECT h.origin, h.seq, r.id::text AS reference_id, r.source_id::text AS source_id, r.pinned_revision, r.scope,
              COALESCE(NULLIF(rr.csl ->> 'title', ''), NULLIF(rv.title, ''), s.title, hs.title, '') AS title
         FROM public.reference_holders h JOIN public.reference_records r ON r.id = h.reference_id
         LEFT JOIN public.sources s ON s.id = r.source_id LEFT JOIN public.held_sources hs ON hs.id = r.source_id
         LEFT JOIN public.source_revisions rv ON rv.source_id = s.id AND rv.revision = r.pinned_revision
         LEFT JOIN LATERAL (SELECT x.csl FROM public.reference_resolutions x WHERE x.reference_id = r.id
                             ORDER BY x.resolved_at DESC LIMIT 1) rr ON true
        WHERE h.holder_kind = $1 AND h.holder_ref = $2 ORDER BY h.seq`,
      [HOLDER_KIND, rel],
    );
    return c.json({ path: rel, references: rows });
  }));

  r.delete("/references/:id", wrap(async (c, who) => {
    const rel = await docs.ownedPath(db, str(c.req.query("path")), who);
    const id = str(c.req.param("id"));
    const n = await db.tx(async (t) => {
      const h = await t.query(
        `DELETE FROM public.reference_holders WHERE holder_kind = $1 AND holder_ref = $2 AND reference_id = $3 AND origin = 'added' RETURNING id`,
        [HOLDER_KIND, rel, id],
      );
      await t.query(`DELETE FROM public.reference_records r WHERE r.id = $1 AND NOT EXISTS (SELECT 1 FROM public.reference_holders x WHERE x.reference_id = r.id)`, [id]);
      return h.length;
    });
    if (!n) return c.json({ error: "no added reference with this id on this document (a cited one is removed from the text)" }, 404);
    await relist(db, reg, rel, who);
    return c.json({ removed: id });
  }));

  // Re-pin ONE transclusion: a new record at the current revision (the quote found again); the caller
  // replaces that transclusion's id. Chips already broken out of it keep the old record, frozen.
  r.post("/references/:id/repin", wrap(async (c, who) => {
    const rel = await docs.ownedPath(db, str(c.req.query("path")), who);
    const old = (await db.query<{ source_id: string; exact: string }>(
      `SELECT source_id::text, selectors #>> '{quote,exact}' AS exact FROM public.reference_records WHERE id = $1`, [str(c.req.param("id"))],
    ))[0];
    if (!old) return c.json({ error: "no reference record with this id" }, 404);
    const placed = await placeReference(db, reg, {
      source_id: old.source_id, exact: old.exact, holder: { kind: HOLDER_KIND, ref: rel, origin: "cited" }, by: who.name,
    });
    return c.json({ replaces: str(c.req.param("id")), record: placed.record, insert: transclusionText(placed.record.id, old.exact) }, 201);
  }));

  // ── the reference panel and the writing-surface tools ───────────────────────────────────
  r.get("/citations", wrap(async (c, who) => c.json(await refinery.citationsOf(db, str(c.req.query("source_id")), who))));
  r.get("/candidates", wrap(async (c, who) => {
    const path = c.req.query("path");
    const rel = path ? await docs.ownedPath(db, path, who) : null;
    return c.json(await candidates(db, str(c.req.query("q")), rel, who));
  }));
  r.get("/hub-context", wrap(async (c, who) => {
    const rel = await docs.ownedPath(db, str(c.req.query("path")), who);
    return c.json(await hubContext(db, rel, await refinery.linksOf(db, rel, who)));
  }));
  r.post("/research", wrap(async (c, who) => {
    const b = await body(c);
    const kind = str(b.kind) === "gap" ? "gap" : "research";
    if (!str(b.query).trim()) return c.json({ error: "query is required" }, 400);
    return c.json(await refinery.queueResearch(rdeps, str(b.path), { query: str(b.query), kind }, who), 202);
  }));

  // ── the refinery from the document (D17 items 5-6, archive) ─────────────────────────────
  r.post("/seed", wrap(async (c, who) => {
    const b = await body(c);
    return c.json(await seedFromIdea(db, reg, str(b.idea_id), who, { folder: str(b.folder) }), 201);
  }));
  r.post("/refinery/start", wrap(async (c, who) => c.json(await refinery.startRefinery(rdeps, str((await body(c)).path), who))));
  r.post("/refinery/archive", wrap(async (c, who) => c.json(await refinery.archiveRefinery(rdeps, str((await body(c)).path), who))));
  r.post("/refinery/open", wrap(async (c, who) => c.json(await refinery.reopenRefinery(rdeps, str((await body(c)).path), who))));

  // The contextual "+" (the document's refinery) and the universal "+" (an EXISTING refinery, named).
  r.post("/user-sources", wrap(async (c, who) => {
    const b = await body(c);
    const input = { title: str(b.title), content: str(b.content), url: b.url ? str(b.url) : undefined, content_type: b.content_type ? str(b.content_type) : undefined };
    if (!input.title.trim() || !input.content.trim()) return c.json({ error: "title and content are required" }, 400);
    if (b.path) return c.json(await refinery.addFromDocument(rdeps, str(b.path), input, who), 201);
    if (!b.refinery_id) {
      return c.json({
        error: "the universal + adds to an existing refinery only: choose one, or create a user document, paste the source there, then open that document's refinery",
      }, 400);
    }
    return c.json(await refinery.addUserSource(rdeps, str(b.refinery_id), input, who), 201);
  }));
  r.get("/user-sources/:id/locate", wrap(async (c, who) =>
    c.json({ source_id: str(c.req.param("id")), ...(await refinery.locateLinks(db, str(c.req.param("id")), who)) })));
  r.delete("/user-sources/:id", wrap(async (c, who) =>
    c.json(await refinery.removeUserSource(rdeps, str(c.req.query("refinery_id")), str(c.req.param("id")), who))));
  r.post("/user-sources/:id/replace", wrap(async (c, who) => {
    const b = await body(c);
    return c.json(await refinery.replaceUserSource(rdeps, str(b.path), str(c.req.param("id")), {
      title: b.title ? str(b.title) : undefined, content: b.content ? str(b.content) : undefined,
    }, who));
  }));
  return r;
}

// ── /workbench/workspace: who the user is, and the bell's per-user read state ───────────────
export function workspaceRouter(db: Db) {
  const w = new Hono();
  // the workspace keys its per-user browser state (layout, UI preferences) by this subject
  w.get("/whoami", wrap(async (c, who) => c.json({ subject_sub: who.sub, actor_sub: who.actor, name: who.name })));
  w.get("/notifications", wrap(async (c, who) => c.json({ acknowledged: await acknowledged(db, who) })));
  w.post("/notifications/:id/ack", wrap(async (c, who) => {
    const out = await acknowledge(db, str(c.req.param("id")), who);
    if (!out) return c.json({ error: "no notification with this id" }, 404);
    return c.json(out);
  }));
  return w;
}

// Start-up: repair the default identity's listing from the documents tree once (D12: the record
// is rebuildable); every other user's is repaired when they connect.
export async function reconcileOnStart(deps: { db: Db; reg: RegistryReader }): Promise<void> {
  try {
    const who = await resolveIdentity(() => undefined, identityConfig());
    const out = await docs.reconcile(deps, who, { legacyRoot: true });
    if (out.repaired.length || out.removed.length || out.failed.length) {
      console.log(`[documents] reconcile on start: ${out.files} files, ${out.repaired.length} re-listed, ${out.removed.length} removed, ${out.failed.length} failed`);
    }
  } catch (e) {
    console.error("[documents] reconcile on start failed (the next workspace connect retries):", (e as Error).message);
  }
}

export async function emptyDocumentsTrash(deps: { db: Db; reg: RegistryReader }): Promise<{ removed: string[] }> {
  return await docs.emptyTrash(deps, "nightly-cleanup");
}
