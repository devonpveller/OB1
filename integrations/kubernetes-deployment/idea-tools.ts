// The Idea Refinery MCP tools' writes (research-workbench rw-p8a4-ideas; operator decisions 2026-11-01): update_idea,
// research_idea and promote_idea are calls of the owner-checked SQL functions (OB1/docker/init-idea-functions.sql,
// slot 370) - the SAME functions the research workbench calls - with THIS server's one owner subject. Another
// owner's idea answers exactly like an idea that does not exist; nothing here writes `ideas` or `idea_revisions`
// itself (the database refuses this server's role if it tries: trg_ideas_write_guard).
//
// WHO the owner is: openbrain-mcp has no per-user sign-in; its idea tools act for the workspace's default identity,
// WORKSPACE_DEFAULT_SUB (blank = "operator", the identity seam's placeholder) - the subject capture_idea files every
// idea under. A user signed in elsewhere is never named by a tool argument.
//
// Pure of the server: index.ts registers the tools and passes its pool client; idea-tools.test.ts drives these with a
// recording fake client.

export interface IdeaClient {
  queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
  queryArray(sql: string, args?: unknown[]): Promise<unknown>;
}

export interface Outcome {
  outcome: string;
  revision?: number;
  title?: string;
  job_id?: string;
  document_path?: string;
}

export function ideaOwner(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): string {
  return (get("WORKSPACE_DEFAULT_SUB") ?? "").trim() || "operator";
}

// the actor these writes record (who acted): this door
export const MCP_ACTOR = "service:openbrain-mcp";

const NOT_FOUND = (id: string) => `no idea with id ${id}`;
const ARCHIVED = "this idea's refinery is archived (it rests until it is reopened from its document); nothing was changed";

async function fn(client: IdeaClient, sql: string, args: unknown[]): Promise<Outcome> {
  return (await client.queryObject<{ o: Outcome }>(sql, args)).rows[0].o;
}

// update_idea: a new revision through idea_edit(). The corpus thought this door writes for every revision (ideas stay
// first-class OB captures) is inserted in the SAME transaction and kept only when the edit changed something.
export async function updateIdea(
  client: IdeaClient, owner: string,
  a: { idea_id: string; idea: string; title?: string; embedding: string; exposure: string; channel: string },
): Promise<{ text: string; isError?: boolean }> {
  const body = a.idea.trim();
  if (!body) throw new Error("idea text is required");
  await client.queryArray("BEGIN");
  try {
    const th = await client.queryObject<{ id: bigint }>(
      `INSERT INTO thoughts (content, embedding, metadata, exposure)
       VALUES ($1, $2::vector, $3::jsonb, $4::text) RETURNING id`,
      [body, a.embedding, JSON.stringify({ type: "idea", source: "mcp", kind: "idea", idea_id: a.idea_id, exposure: a.exposure }), a.exposure],
    );
    const o = await fn(client, `SELECT public.idea_edit($1::uuid, $2, $3, $4, $5, $6, $7) AS o`,
      [a.idea_id, owner, MCP_ACTOR, body, a.title?.trim() || null, a.embedding, th.rows[0].id]);
    if (o.outcome !== "changed") {
      await client.queryArray("ROLLBACK"); // the thought goes with an edit that did not happen
      if (o.outcome === "not_found") throw new Error(NOT_FOUND(a.idea_id));
      if (o.outcome === "archived") return { text: ARCHIVED, isError: true };
      return { text: `No change — the text is identical to the current version (idea_id: ${a.idea_id}); nothing re-queued.` };
    }
    await client.queryArray("COMMIT");
    return { text:
      `Updated idea "${o.title}" (idea_id: ${a.idea_id}, revision ${o.revision}). It will be re-researched in the background; ` +
      `the refreshed findings will land in the idea's room in the research workspace and as an update on its Mattermost ${a.channel} thread.` };
  } catch (e) {
    try { await client.queryArray("ROLLBACK"); } catch { /* connection already broken, or rolled back above */ }
    throw e;
  }
}

// research_idea: research now through idea_research() (queued at once - no flag for a later pass).
export async function researchIdea(client: IdeaClient, owner: string, ideaId: string, channel: string): Promise<{ text: string; isError?: boolean }> {
  const o = await fn(client, `SELECT public.idea_research($1::uuid, $2, $3) AS o`, [ideaId, owner, MCP_ACTOR]);
  if (o.outcome === "not_found") throw new Error(NOT_FOUND(ideaId));
  if (o.outcome === "archived") return { text: ARCHIVED, isError: true };
  return { text:
    `Queued idea ${ideaId} for immediate research (job ${o.job_id}). ` +
    `Findings will land in the idea's room in the research workspace and in Mattermost ${channel} — follow along there.` };
}

// promote_idea: PROMOTE through idea_promote(). The document is the refinery's ONE user document, already tethered to
// the idea (the workspace's `create document` seeds it); the tool records the promotion with that pointer.
export async function promoteIdea(client: IdeaClient, owner: string, ideaId: string, documentPath: string): Promise<{ text: string; isError?: boolean }> {
  const path = documentPath.trim();
  if (!path) throw new Error("document_path is required (the idea refinery's user document)");
  const o = await fn(client, `SELECT public.idea_promote($1::uuid, $2, $3, $4) AS o`, [ideaId, owner, MCP_ACTOR, path]);
  if (o.outcome === "not_found") throw new Error(NOT_FOUND(ideaId));
  if (o.outcome === "archived") return { text: ARCHIVED, isError: true };
  if (o.outcome === "no_document") {
    return { text: `The idea has no user document at ${path}. Use "create document" on the idea in the research workspace first; it seeds the document and promotes the idea.`, isError: true };
  }
  return { text: o.outcome === "unchanged" ? `Idea ${ideaId} is already promoted to ${path}.` : `Promoted idea ${ideaId}; its document is ${path}.` };
}
