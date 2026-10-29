// The bell's read state (research-workbench P2b, D13 item 7) - PER USER (operator 2026-10-28: the
// front-end context is the user's own). The bell READS the contract's notification events
// (GET /workbench/contract/notifications) and its progress indicators through the contract (the
// progress_indicators registry and jobs(state)); what this user has read is notification_acks, one
// row per (owner, notification), so it survives a reload. A repeat of an event after the
// acknowledgement (its last_seen moves on) is unread again.
import type { Db } from "../contracts/db.ts";
import type { Identity } from "../middleware/identity.ts";

export async function acknowledge(db: Db, id: string, who: Identity) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await db.query<{ id: string; acked_at: string }>(
    `INSERT INTO public.notification_acks (owner_sub, actor_sub, notification_id)
     SELECT $2, $3, n.id FROM public.research_notifications n WHERE n.id = $1::uuid
        -- only an event this user can read (the same visibility as contracts/repo/system.ts notifications):
        -- another user's id answers like a nonexistent one (404), never as an existence oracle
        AND (n.entity IS NULL OR NOT starts_with(n.entity, 'document:')
             OR starts_with(n.entity, 'document:documents/' || $4 || '/')
             OR EXISTS (SELECT 1 FROM public.user_document_listings d
                         WHERE 'document:' || d.path = n.entity AND d.owner_sub = $2))
        AND (n.entity IS NULL OR NOT starts_with(n.entity, 'idea:')
             OR NOT EXISTS (SELECT 1 FROM public.ideas i WHERE 'idea:' || i.id::text = n.entity AND i.owner_sub <> $2))
     ON CONFLICT (owner_sub, notification_id) DO UPDATE SET acked_at = now(), actor_sub = EXCLUDED.actor_sub
     RETURNING notification_id::text AS id, acked_at`,
    [id, who.sub, who.actor, who.key],
  );
  return rows[0] ?? null;
}

// This user's acknowledgements that still hold (the event has not repeated since).
export async function acknowledged(db: Db, who: Identity) {
  return await db.query<{ id: string; acked_at: string }>(
    `SELECT a.notification_id::text AS id, a.acked_at
       FROM public.notification_acks a JOIN public.research_notifications n ON n.id = a.notification_id
      WHERE a.owner_sub = $1 AND n.last_seen <= a.acked_at`,
    [who.sub],
  );
}
