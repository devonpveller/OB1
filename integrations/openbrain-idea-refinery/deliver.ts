// deliver.ts - the refinery's dossier delivery (IR §7), research-workbench rw-p8a4-ideas (operator 2026-11-01) and
// rw-idea-privacy (operator 2026-11-02: "ideas are completely user isolated"): the dossier is written into the idea's
// ONE room in the research workspace (idea_deliver_dossier(), slot 370) and NOWHERE else.
//
//   1. the room   always: one 'dossier' entry per research job (a retried pass adds nothing). An archived idea gets
//                 nothing - no room entry, no notification (D17 archive).
//   2. no Mattermost post. rw-idea-privacy: the post went to one shared channel (#ideas, created PUBLIC) that every
//                 member of the bot's team could read. A dossier may go to Mattermost only into a channel whose one
//                 human member is the idea's owner, which needs an owner -> Mattermost user mapping; none exists
//                 (checked 2026-11-02: the identity seam's workspace_users holds sub / name / email, nothing names a
//                 Mattermost user), so this module has no Mattermost dependency at all.
//   3. delivered  status researched (never `promoted`: a promotion is the user's, through idea_promote(), and the
//                 database refuses this service's role a promotion of its own); thread_root is left as it is.
// The resurface cross-link (IR §8) names only the SAME owner's parked ideas (idea_resurface()).
// Pure of the service: index.ts passes its database; deliver.test.ts drives this with a fake.

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
  resurfaceMaxDist: number;
  log(msg: string): void;
}

export function renderDossier(idea: DeliverIdea, result: JobResult, isUpdate: boolean, related: string[] = []): string {
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
  parts.push(`_The value call is yours. What would you want to explore? Ask here in the room to hone this idea._`);
  return parts.join("\n\n");
}

export type Delivered = "delivered" | "skipped";

export async function deliverForIdea(deps: DeliverDeps, idea: DeliverIdea, result: JobResult): Promise<Delivered> {
  if (!idea.last_job_id) return "skipped";
  const isUpdate = !!idea.thread_root; // a thread_root: the idea was delivered before (the Mattermost era)
  // resurface only on a new idea's first dossier, and only the same owner's parked ideas
  const related = isUpdate ? [] : (await deps.sql<{ title: string }>(
    `SELECT title FROM public.idea_resurface($1::uuid, $2, 2)`, [idea.id, deps.resurfaceMaxDist],
  ).catch(() => [])).map((r) => r.title);
  // the room (the record) - the only delivery
  const room = (await deps.sql<{ o: { outcome: string; room_id?: string } }>(
    `SELECT public.idea_deliver_dossier($1::uuid, $2, $3, $4::jsonb) AS o`,
    [idea.id, idea.last_job_id, renderDossier(idea, result, isUpdate, related),
      JSON.stringify({ update: isUpdate, related, source: "idea-refinery" })],
  ))[0]?.o;
  if (!room || room.outcome === "archived" || room.outcome === "not_found") {
    deps.log(`idea ${idea.id}: not delivered (${room?.outcome ?? "no answer"}) - an archived refinery rests`);
    return "skipped";
  }
  // delivered (never promoted; an idea archived meanwhile is left resting)
  await deps.sql(
    `UPDATE ideas SET status = 'researched' WHERE id = $1 AND status IN ('new', 'queued', 'dirty')`,
    [idea.id],
  );
  deps.log(`delivered idea ${idea.id} -> room ${room.room_id}`);
  return "delivered";
}
