// A user's add, end to end (rw-p5a-intake; the ingestion model, brainstorm 2026-09-25, agreed 19:59).
//
// ONE path for every inlet - the panel's general add (a link, file or drop from the title bar: it names
// the refinery), its contextual add (from inside a refinery, or from a document, whose refinery it is)
// and the Open WebUI inlet (origin owui, through the same route) - and nothing typed beyond the link:
//   queued -> fetching    the link, through the research service's proxy-bound fetch (research_fetch.ts)
//          -> extracting  a PDF's bytes (fetched or added as a file) or a saved page, through the
//                         workbench's extractor (openbrain-extract, the file import's)
//          -> holding     the one transaction that HOLDS it in the idea refinery (contracts/repo/ideas.ts
//                         addHeld through documents/refinery.ts): stored, chunked, embedded, state held,
//                         revision 1 - never admitted to the knowledge database on arrival, never a watch
//                         proposal (P5b's mechanism), never outside a refinery
//          -> held        (or failed with a fixed reason; or cancelled while queued / fetching / extracting)
// The job row is the subject's (owner_sub = the identity seam's subject_sub); the source it holds is
// shared knowledge in waiting (held is a quality gate, not privacy - 07-MULTI-USER).
import type { Db } from "../contracts/db.ts";
import type { RefineryDeps } from "../documents/refinery.ts";
import * as refinery from "../documents/refinery.ts";
import { DocError } from "../documents/repo.ts";
import { NotFound, Conflict } from "../contracts/repo/lifecycle.ts";
import { type Identity, ownerKey } from "../middleware/identity.ts";
import { fileContentType, type IntakeContentType, isIntakeContentType } from "./content_types.ts";
import { type IntakeFetch, IntakeFetchError } from "./research_fetch.ts";

export type Extract = (bytes: Uint8Array, filename: string) => Promise<{ markdown: string; title: string }>;

export interface AddDeps {
  db: Db;
  rdeps: RefineryDeps;
  fetch: IntakeFetch | null; // null = the research service is not configured (503)
  extract: Extract;
}

// What a failed add records - a fixed text per cause (another service's words never land in the row).
export const FAILURE_TEXT: Record<string, string> = {
  refused_target: "the link was refused: not a public web address",
  unsupported_type: "not a web page, PDF or YouTube video",
  type_mismatch: "the link is not the content type chosen for it",
  too_large: "the page or file is too large",
  no_transcript: "the video has no transcript that can be read",
  empty_extract: "no readable text in it",
  upstream_status: "the page answered with an error",
  network: "the page could not be reached",
  timeout: "the page did not answer in time",
  too_many_redirects: "the link redirects too many times",
  fetch_failed: "the page could not be fetched",
  research_unavailable: "the research service is not answering",
  research_unconfigured: "the research service is not configured for the workspace (RESEARCH_URL, RESEARCH_WORKSPACE_KEY)",
  upstream_error: "the research service could not fetch it",
  extract_failed: "the file could not be read",
  no_payload: "the file is gone; add it again",
  hold_failed: "it could not be held in the refinery",
};

export interface AddJobRow {
  id: string;
  status: string;
  owner_sub: string | null;
  actor_sub: string | null;
  url: string | null;
  filename: string | null;
  refinery_id: string | null;
  doc_path: string | null;
  content_type: string | null;
  origin: string;
}

// the subject the job acts for, as the refinery calls need it (owner checks use sub; the document path
// check uses the directory key) - rebuilt from the job row the route wrote from the identity seam
async function actingFor(job: AddJobRow): Promise<Identity> {
  const sub = job.owner_sub ?? "";
  return { sub, actor: job.actor_sub ?? sub, name: sub, key: await ownerKey(sub), kind: "user", admin: false, impersonating: null };
}

// a status move that happens only while the job is still wanted (a cancel landed meanwhile = no row)
async function advance(db: Db, id: string, to: string, from: string[]): Promise<boolean> {
  const r = await db.query(`UPDATE public.import_jobs SET status = $2 WHERE id = $1 AND status = ANY($3) RETURNING id`, [id, to, from]);
  return r.length > 0;
}

function b64bytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function runAdd(deps: AddDeps, jobId: string): Promise<void> {
  const db = deps.db;
  const job = (await db.query<AddJobRow>(
    `SELECT id::text AS id, status, owner_sub, actor_sub, url, filename, refinery_id::text AS refinery_id, doc_path, content_type, origin
       FROM public.import_jobs WHERE id = $1 AND mode = 'add'`, [jobId],
  ))[0];
  if (!job || job.status !== "queued") return;
  const fail = async (code: string) => {
    await db.query(`UPDATE public.import_jobs SET status = 'failed', error = $2 WHERE id = $1 AND status <> 'cancelled'`,
      [jobId, FAILURE_TEXT[code] ?? FAILURE_TEXT.hold_failed]);
  };
  try {
    const declared = isIntakeContentType(job.content_type) ? job.content_type : null;
    let input: { title: string; content: string; url?: string; content_type: IntakeContentType };
    let provenance: Record<string, unknown>;
    if (job.url) {
      if (!deps.fetch) return void await fail("research_unconfigured");
      if (!(await advance(db, jobId, "fetching", ["queued"]))) return;
      const got = await deps.fetch(job.url, declared);
      provenance = { fetched_by: "research-service /intake/fetch", egress: got.egress, final_url: got.final_url, redirects: got.redirects };
      if (got.content_type === "pdf") {
        if (!(await advance(db, jobId, "extracting", ["fetching"]))) return;
        const ex = await deps.extract(b64bytes(got.bytes_b64 ?? ""), got.title || "document.pdf").catch(() => null);
        if (!ex?.markdown?.trim()) return void await fail("extract_failed");
        input = { title: ex.title || got.title || job.url, content: ex.markdown, url: job.url, content_type: "pdf" };
      } else {
        if (!got.text?.trim()) return void await fail("empty_extract");
        input = { title: got.title || job.url, content: got.text, url: job.url, content_type: got.content_type };
      }
    } else {
      const p = (await db.query<{ filename: string; bytes: Uint8Array }>(`SELECT filename, bytes FROM public.import_job_payloads WHERE job_id = $1`, [jobId]))[0];
      if (!p) return void await fail("no_payload");
      const type = fileContentType(p.filename, p.bytes);
      if (!type) return void await fail("unsupported_type");
      if (!(await advance(db, jobId, "extracting", ["queued"]))) return;
      const ex = await deps.extract(p.bytes, p.filename).catch(() => null);
      if (!ex?.markdown?.trim()) return void await fail("extract_failed");
      input = { title: ex.title || p.filename, content: ex.markdown, content_type: type };
      provenance = { file: p.filename };
    }
    if (!(await advance(db, jobId, "holding", ["fetching", "extracting"]))) return;
    const who = await actingFor(job);
    const held = { ...input, metadata: { intake: { job_id: jobId, origin: job.origin, ...provenance } } };
    const added = job.refinery_id
      ? await refinery.addUserSource(deps.rdeps, job.refinery_id, held, who)
      : await refinery.addFromDocument(deps.rdeps, job.doc_path!, held, who);
    const sourceId = (added as { source: { source_id: string } }).source.source_id;
    await db.query(`UPDATE public.import_jobs SET status = 'held', held_source_id = $2, error = NULL WHERE id = $1`, [jobId, sourceId]);
    await db.query(`DELETE FROM public.import_job_payloads WHERE job_id = $1`, [jobId]);
  } catch (e) {
    if (e instanceof IntakeFetchError) return void await fail(e.code);
    if (e instanceof DocError || e instanceof NotFound || e instanceof Conflict) {
      // the refinery's own fixed text (no such refinery, archived, tombstoned URL, ...)
      await db.query(`UPDATE public.import_jobs SET status = 'failed', error = $2 WHERE id = $1 AND status <> 'cancelled'`, [jobId, (e as Error).message.slice(0, 300)]);
      return;
    }
    console.error(`[intake] add ${jobId} failed:`, String((e as Error)?.message ?? e).slice(0, 500));
    await fail("hold_failed");
  }
}
