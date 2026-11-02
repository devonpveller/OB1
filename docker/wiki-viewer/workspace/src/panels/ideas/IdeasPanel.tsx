// The ideas panel (research-workbench rw-p8a4-ideas, D17 item 5): the caller's ideas by state - new, queued, dirty,
// researched, engaged, resurfaced (a parked idea a newer idea's dossier cross-linked, IR section 8), dormant, promoted
// - each with the date of its last session and of its dossier; archived refineries rest in their own collapsible
// list (D17 archive: nothing is deleted). Opening one opens the idea view (the refinery view, IdeaPanel).
// Reads GET /workbench/contract/ideas - the identity seam's subject's ideas only.
import { useEffect, useMemo, useState } from "react";
import { C, get } from "../../lib/api";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { openPanel } from "../../shell/dock";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";

export interface IdeaSummary {
  id: string;
  title: string;
  status: string;
  summary: string;
  current_revision: number;
  updated_at: string;
  document_path: string | null;
  last_session_at: string | null;
  dossier_at: string | null;
  resurfaced_at: string | null;
}

// the order states are listed in; "resurfaced" is a dormant idea with a resurfacing after it went dormant
export const STATE_ORDER = ["new", "queued", "dirty", "researched", "engaged", "resurfaced", "dormant", "promoted"];
export const stateOf = (i: IdeaSummary) => (i.status === "dormant" && i.resurfaced_at ? "resurfaced" : i.status);
export const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

export function ideaLeaf(i: IdeaSummary): Leaf {
  const badges = [stateOf(i)];
  badges.push(day(i.last_session_at) ? `last session ${day(i.last_session_at)}` : "no session yet");
  badges.push(day(i.dossier_at) ? `dossier ${day(i.dossier_at)}` : "no dossier yet");
  return {
    key: i.id,
    label: <span data-idea={i.id} data-idea-state={stateOf(i)}>{i.title || "(untitled idea)"}</span>,
    detail: <span>{i.summary.slice(0, 280)}{i.document_path ? ` - document ${i.document_path}` : ""}</span>,
    badges,
  };
}

export function IdeasPanel(_p: PanelProps) {
  const [rows, setRows] = useState<IdeaSummary[] | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let live = true;
    get<{ ideas: IdeaSummary[] }>(`${C}/ideas?limit=200`)
      .then((r) => live && setRows(r?.ideas ?? []))
      .catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, []);
  const { active, archived } = useMemo(() => {
    const all = rows ?? [];
    const rank = (i: IdeaSummary) => {
      const k = STATE_ORDER.indexOf(stateOf(i));
      return k < 0 ? STATE_ORDER.length : k;
    };
    return {
      active: all.filter((i) => i.status !== "archived").sort((a, b) => rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at)),
      archived: all.filter((i) => i.status === "archived"),
    };
  }, [rows]);
  const counts = STATE_ORDER.map((s) => [s, active.filter((i) => stateOf(i) === s).length] as const).filter(([, n]) => n > 0);
  const open = (l: Leaf) => (
    <button type="button" data-action="open-idea" onClick={() => openPanel("idea", { idea_id: l.key })}>Open</button>
  );
  return (
    <div className="ws-side ws-ideas">
      <Disclosure
        testId="ideas-disclosure"
        summary={<span>{active.length} idea{active.length === 1 ? "" : "s"}{counts.length ? ` - ${counts.map(([s, n]) => `${n} ${s}`).join(", ")}` : ""}</span>}
        leaves={active.map(ideaLeaf)}
        actions={open}
        empty="no ideas yet"
      />
      {/* D17 archive: a resting refinery moves here; it reopens from its document */}
      <Disclosure
        testId="ideas-archived"
        summary={<span>archived ({archived.length})</span>}
        leaves={archived.map(ideaLeaf)}
        actions={open}
        empty="no archived refineries"
      />
      {msg && <p className="ws-muted" data-testid="ideas-msg">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "ideas", version: 1, title: "Ideas", kind: "side", component: IdeasPanel, position: "left" });
registerNav({ id: "ideas", version: 1, label: "Ideas", order: 45, panel: "ideas" });
