// deliver.ts - the refinery's dossier delivery (IR §7), research-workbench rw-p8a4-ideas (operator 2026-11-01): the
// dossier is written into the idea's ONE room in the research workspace (idea_deliver_dossier(), slot 370) AND still
// posted to the idea's Mattermost thread, until the later refactor retires the Mattermost post.
//
//   1. the room   first, always: one 'dossier' entry per research job (a retried pass adds nothing). An archived
//                 idea gets nothing - no room entry, no Mattermost post, no notification (D17 archive).
//   2. Mattermost when a token is configured: the thread root on first research, an UPDATE reply after. A failed post
//                 leaves the idea undelivered, so the next pass retries it (the room entry is not written twice).
//   3. delivered  status researched (never `promoted`: a promotion is the user's, through idea_promote(), and the
//                 database refuses this service's role a promotion of its own), thread_root kept when Mattermost is off.
// The resurface cross-link (IR §8) names only the SAME owner's parked ideas (idea_resurface()).
// Pure of the service: index.ts passes its database and Mattermost calls; deliver.test.ts drives this with fakes.

export type JobResult = { synthesis?: string; cited_sources?: unknown[]; [k: string]: unknown };

export interface DeliverIdea {
  id: string;
  title: string;
  summary: string;
  thread_root: string | null;
  last_job_id: string | null;
}

export interface DeliverDeps {
  sql<T>(text: string, args?: unknown[]): Promise<T[]>;
  mm: null | {
    channel(): Promise<string>;
    post(channelId: string, message: string, rootId: string | null): Promise<{ id: string }>;
    permalink(postId: string): string | null;
  };
  resurfaceMaxDist: number;
  log(msg: string): void;
}

export function renderDossier(idea: DeliverIdea, result: JobResult, isUpdate: boolean, related: string[] = [], where: "mattermost" | "room" = "mattermost"): string {
  const synthesis = String(result.synthesis ?? "").trim() || "_(the research returned no synthesis)_";
  const sources = Array.isArray(result.cited_sources) ? result.cited_sources as Array<Record<string, unknown>> : [];
  const srcLines = sources.slice(0, 8).map((s, i) => {
    const title = String(s.title ?? s.url ?? `source ${i + 1}`);
    return `${i + 1}. ${title}${s.url ? ` — ${s.url}` : ""}`;
  });
  const head = isUpdate
    ? `↻ **Updated: ${idea.title}** — you changed this idea; here's fresh research.`
    : `💡 **${idea.title}**\n\n${idea.summary}`;
  const parts = [head, `**The landscape + what we already know**\n\n${synthesis}`];
  if (srcLines.length) parts.push(`**Sources**\n${srcLines.join("\n")}`);
  if (related.length) parts.push(`🔗 _This connects to ideas you parked earlier: ${related.join(", ")}. Worth revisiting?_`);
  parts.push(where === "room"
    ? `_The value call is yours. What would you want to explore? Ask here in the room to hone this idea._`
    : `_The value call is yours. What would you want to explore? Reply here to hone this idea._`);
  return parts.join("\n\n");
}

export type Delivered = "delivered" | "skipped";

export async function deliverForIdea(deps: DeliverDeps, idea: DeliverIdea, result: JobResult): Promise<Delivered> {
  if (!idea.last_job_id) return "skipped";
  const isUpdate = !!idea.thread_root;
  // resurface only on a new idea's first dossier, and only the same owner's parked ideas
  const related = isUpdate ? [] : (await deps.sql<{ title: string }>(
    `SELECT title FROM public.idea_resurface($1::uuid, $2, 2)`, [idea.id, deps.resurfaceMaxDist],
  ).catch(() => [])).map((r) => r.title);
  // 1. the room (the record), first
  const room = (await deps.sql<{ o: { outcome: string; room_id?: string } }>(
    `SELECT public.idea_deliver_dossier($1::uuid, $2, $3, $4::jsonb) AS o`,
    [idea.id, idea.last_job_id, renderDossier(idea, result, isUpdate, related, "room"),
      JSON.stringify({ update: isUpdate, related, source: "idea-refinery" })],
  ))[0]?.o;
  if (!room || room.outcome === "archived" || room.outcome === "not_found") {
    deps.log(`idea ${idea.id}: not delivered (${room?.outcome ?? "no answer"}) - an archived refinery rests`);
    return "skipped";
  }
  // 2. Mattermost (the bridge), when configured
  let rootId = idea.thread_root;
  if (deps.mm) {
    const channelId = await deps.mm.channel();
    const msg = renderDossier(idea, result, isUpdate, related, "mattermost");
    if (isUpdate) await deps.mm.post(channelId, msg, rootId);
    else rootId = (await deps.mm.post(channelId, msg, null)).id;
  }
  // 3. delivered (never promoted; an idea archived meanwhile is left resting)
  await deps.sql(
    `UPDATE ideas SET status = 'researched', thread_root = COALESCE($2, thread_root) WHERE id = $1 AND status IN ('new', 'queued', 'dirty')`,
    [idea.id, rootId],
  );
  const link = rootId && deps.mm ? deps.mm.permalink(rootId) : null;
  deps.log(`delivered idea ${idea.id} ("${idea.title}") -> room ${room.room_id}${rootId ? `, thread ${rootId}` : ""}${link ? " " + link : ""}`);
  return "delivered";
}
