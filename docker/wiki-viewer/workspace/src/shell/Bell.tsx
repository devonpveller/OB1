// The notifications bell (D13 item 7, in the title bar since 2026-09-25 19:51). It READS the
// contract's notification events (GET /workbench/contract/notifications: class, subject, origin, the
// page slug or entity) and shows the unread count; an acknowledgement is stored in the database
// (POST /workbench/workspace/notifications/<id>/ack), so it holds across a reload. Its progress
// indicators are the progress_indicators registry, each counted through jobs(state).
import { useEffect, useState } from "react";
import { C, get, post, q, W } from "../lib/api";
import { openPanel } from "./dock";
import { setState } from "../lib/store";

export interface Notification {
  id: string;
  class: string;
  subject: string;
  slug: string | null;
  entity: string | null;
  origin: string | null;
  error: string | null;
  last_seen: string;
  count: number;
}

export const POLL_MS = 1000;
const PROGRESS_MS = 5000;

type Jump = { kind: "page"; href: string } | { kind: "entity"; open: () => void; label: string } | null;

// Where a notification jumps: a page (its slug, rendered by the viewer) or an entity the workspace
// opens. An entity the workspace has no view for gets no jump - never a dead link.
export function jumpOf(n: Notification): Jump {
  if (n.slug) return { kind: "page", href: `/${n.slug.replace(/^\/+/, "")}` };
  const m = /^(idea|document|source):(.+)$/.exec(n.entity ?? "");
  if (!m) return null;
  if (m[1] === "idea") {
    const [id, , dossier] = m[2].split(":");
    if (dossier) {
      return {
        kind: "entity", label: "open the dossier",
        open: () => {
          setState({ reference: { reference_id: null, source_id: dossier, chunk_idx: null } });
          openPanel("reference");
        },
      };
    }
    return { kind: "entity", label: "open the idea", open: () => openPanel("refinery", { idea_id: id }) };
  }
  if (m[1] === "document") return { kind: "entity", label: "open the document", open: () => setState({ documentPath: m[2] }) };
  return {
    kind: "entity", label: "open the source",
    open: () => {
      setState({ reference: { reference_id: null, source_id: m[2], chunk_idx: null } });
      openPanel("reference");
    },
  };
}

function Progress() {
  const [counts, setCounts] = useState<{ key: string; label: string; n: number }[]>([]);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const reg = await get(`${C}/registries/progress_indicators`);
        const entries = [...reg.entries].sort((a: any, b: any) => (a.definition?.order ?? 0) - (b.definition?.order ?? 0));
        const out = [];
        for (const e of entries) {
          const states: string[] = e.definition?.states ?? [];
          let n = 0;
          for (const s of states.length ? states : [""]) {
            const j = await get(`${C}/jobs?kinds=${q(e.definition.job_kind)}${s ? `&state=${q(s)}` : ""}&limit=200`);
            n += j.jobs.length;
          }
          out.push({ key: e.key as string, label: e.label as string, n });
        }
        if (live) setCounts(out);
      } catch { /* the bell keeps its last counts */ }
    };
    tick();
    const t = setInterval(tick, PROGRESS_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return (
    <span className="ws-progress" data-testid="progress">
      {counts.map((c) => <span key={c.key} className="ws-progress-item" data-indicator={c.key}>{c.label} {c.n}</span>)}
    </span>
  );
}

export function Bell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const [n, a] = await Promise.all([get(`${C}/notifications?limit=100`), get(`${W}/notifications`)]);
        if (!live) return;
        setItems(n.notifications);
        setAcked(new Set(a.acknowledged.map((x: { id: string }) => x.id)));
      } catch { /* offline: keep the last state */ }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  const unread = items.filter((n) => !acked.has(n.id));
  const ack = async (id: string) => {
    await post(`${W}/notifications/${id}/ack`);
    setAcked(new Set([...acked, id]));
  };
  return (
    <span className="ws-bell-wrap">
      <Progress />
      <button type="button" className="ws-tb-btn ws-bell" data-testid="bell" aria-expanded={open} onClick={() => setOpen(!open)}>
        Notifications <span className="ws-count" data-testid="unread">{unread.length}</span>
      </button>
      {open && (
        <div className="ws-popover ws-notifications" role="dialog" aria-label="notifications">
          {items.length === 0 && <p className="ws-muted">No notifications.</p>}
          <ul>
            {items.map((n) => {
              const j = jumpOf(n);
              return (
                <li key={n.id} className={`ws-note${acked.has(n.id) ? " ws-read" : ""}`} data-notification={n.id} data-class={n.class}>
                  <span className={`ws-badge ws-class-${n.class}`}>{n.class}</span>
                  <span className="ws-subject">{n.subject}</span>
                  {n.origin && <span className="ws-origin">from {n.origin}</span>}
                  {n.count > 1 && <span className="ws-muted"> x{n.count}</span>}
                  {j?.kind === "page" && <a className="ws-jump" href={j.href} target="_blank" rel="noopener">open the page</a>}
                  {j?.kind === "entity" && <button type="button" className="ws-jump" onClick={j.open}>{j.label}</button>}
                  {!acked.has(n.id) && <button type="button" className="ws-ack" onClick={() => ack(n.id)}>acknowledge</button>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </span>
  );
}
