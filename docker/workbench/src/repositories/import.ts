// Import / grounding ingest repository (P5.5/5.6, shared by P6). The single
// upload pipeline: extract → (images→assets) → chunk → embed → find_or_create →
// link notebook and/or entities — with the source + chunks + links landing in
// ONE transaction (G8) so a mid-sequence failure can't leave a source with no
// chunks/links. Durable job state in import_jobs (survives restart; drives the
// P6 badge via staged/committed).
import { query, withTransaction } from "../db/pool.ts";
import { embed, toVector } from "../util/embed.ts";
import { chunkText } from "../util/chunk.ts";
import { vaultWriteBinary } from "../util/vault.ts";
import type { ImportJob } from "../types.ts";

export async function createJob(
  targetEntityIds: number[],
  targetNotebook: string | null,
  staged: boolean,
  // rw-p5a-intake: the identity seam's subject (owner) and actor, and what the import fetches or reads
  who: { owner: string; actor: string; url?: string | null; filename?: string | null } | null = null,
): Promise<ImportJob> {
  const rows = await query<ImportJob>(
    `INSERT INTO public.import_jobs (status, target_entity_ids, target_notebook, staged, owner_sub, actor_sub, url, filename)
     VALUES ('queued', $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [targetEntityIds, targetNotebook, staged, who?.owner ?? null, who?.actor ?? null, who?.url ?? null, who?.filename ?? null],
  );
  return rows[0];
}

// rw-p5a-intake: a status move made only while the job is still wanted - a job cancelled from the intake
// panel meanwhile is left as it is (false: the pipeline stops)
export async function advanceJob(id: string, to: string, from: string[]): Promise<boolean> {
  const rows = await query<{ id: string }>(`UPDATE public.import_jobs SET status = $2 WHERE id = $1 AND status = ANY($3) RETURNING id`, [id, to, from]);
  return rows.length > 0;
}
export async function failJob(id: string, error: string): Promise<void> {
  await query(`UPDATE public.import_jobs SET status = 'failed', error = $2 WHERE id = $1 AND status <> 'cancelled'`, [id, error]);
}
export async function storePayload(id: string, filename: string, bytes: Uint8Array): Promise<void> {
  await query(`INSERT INTO public.import_job_payloads (job_id, filename, bytes) VALUES ($1, $2, $3) ON CONFLICT (job_id) DO NOTHING`, [id, filename, bytes]);
}
export async function getPayload(id: string): Promise<{ filename: string; bytes: Uint8Array } | null> {
  return (await query<{ filename: string; bytes: Uint8Array }>(`SELECT filename, bytes FROM public.import_job_payloads WHERE job_id = $1`, [id]))[0] ?? null;
}
export async function dropPayload(id: string): Promise<void> {
  await query(`DELETE FROM public.import_job_payloads WHERE job_id = $1`, [id]);
}

export async function updateJob(id: string, fields: Partial<ImportJob>): Promise<void> {
  const set: string[] = [];
  const args: unknown[] = [id];
  for (const [k, v] of Object.entries(fields)) {
    set.push(`${k} = $${args.length + 1}`);
    args.push(v);
  }
  if (!set.length) return;
  await query(`UPDATE public.import_jobs SET ${set.join(", ")} WHERE id = $1`, args);
}

export async function getJob(id: string): Promise<ImportJob | null> {
  const rows = await query<ImportJob>(`SELECT * FROM public.import_jobs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function recentJobs(limit = 50): Promise<ImportJob[]> {
  return await query<ImportJob>(
    `SELECT * FROM public.import_jobs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
}

// The transactional core. Embeddings are computed BEFORE the tx (network I/O);
// the tx is purely DB writes so it stays short.
export async function ingestSource(opts: {
  markdown: string;
  title: string;
  contentType: string;
  url?: string | null;
  notebook?: string | null;
  targetNotebook?: string | null; // a threads.id (UUID)
  targetEntityIds?: number[];
  metadata?: Record<string, unknown>;
}): Promise<{ sourceId: string; chunkCount: number; wasDuplicate: boolean }> {
  const srcEmbedding = await embed(`${opts.title}\n\n${opts.markdown}`);
  const chunks = chunkText(opts.markdown);
  const chunkEmbeddings: number[][] = [];
  for (const ch of chunks) chunkEmbeddings.push(await embed(ch));

  return await withTransaction(async (c) => {
    const fc = await c.queryObject<{ id: string; was_duplicate: boolean }>(
      `SELECT * FROM public.find_or_create_source($1,$2,NULL,$3,$4,$5,NULL,$6::vector,$7::jsonb)`,
      [
        opts.url ?? null, opts.markdown, opts.title, opts.contentType,
        opts.notebook ?? null, toVector(srcEmbedding), JSON.stringify(opts.metadata ?? {}),
      ],
    );
    const sourceId = fc.rows[0].id;
    const wasDuplicate = fc.rows[0].was_duplicate;

    // Replace chunks (idempotent on re-import).
    await c.queryObject(`DELETE FROM public.source_chunks WHERE source_id = $1`, [sourceId]);
    for (let i = 0; i < chunks.length; i++) {
      await c.queryObject(
        `INSERT INTO public.source_chunks (source_id, idx, content, embedding)
         VALUES ($1,$2,$3,$4::vector)`,
        [sourceId, i, chunks[i], toVector(chunkEmbeddings[i])],
      );
    }

    // Notebook membership (P5) — confirmed deliberate link.
    if (opts.targetNotebook) {
      await c.queryObject(
        `SELECT public.link_source_to_thread($1,$2,'deliberate',NULL,'confirmed')`,
        [opts.targetNotebook, sourceId],
      );
    }

    // Entity grounding links (P6.3) — user_linked wins on PK collision.
    for (const eid of opts.targetEntityIds ?? []) {
      await c.queryObject(
        `INSERT INTO public.source_entities (source_id, entity_id, mention_role, confidence, evidence)
         VALUES ($1,$2,'user_linked',1.0,$3)
         ON CONFLICT (source_id, entity_id)
         DO UPDATE SET mention_role='user_linked', confidence=1.0, evidence=EXCLUDED.evidence`,
        [sourceId, eid, `manual:operator@${new Date().toISOString()}`],
      );
    }
    return { sourceId, chunkCount: chunks.length, wasDuplicate };
  });
}

// Write extracted images to the wiki-assets volume under assets/<source-id>/ and
// rewrite the source content to reference them inline (P5.6). Post-commit +
// best-effort (assets are additive files; gitignored so they never enter vault
// git).
export async function attachImages(
  sourceId: string,
  markdown: string,
  images: { name: string; b64: string; mime?: string }[],
): Promise<void> {
  if (!images?.length) return;
  const refs: string[] = [];
  for (const img of images) {
    const bytes = Uint8Array.from(atob(img.b64), (ch) => ch.charCodeAt(0));
    await vaultWriteBinary(`assets/${sourceId}/${img.name}`, bytes);
    refs.push(`![${img.name}](assets/${sourceId}/${img.name})`);
  }
  const newContent = `${markdown}\n\n## Images\n\n${refs.join("\n\n")}\n`;
  await query(`UPDATE public.sources SET content = $2 WHERE id = $1`, [sourceId, newContent]);
}
