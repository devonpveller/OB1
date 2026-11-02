// The idea view = the refinery view (research-workbench rw-p8a4-ideas, D17 items 5-6, the D17 archive, the ingestion
// model's user source list). Over GET /workbench/contract/ideas/{id} (the caller's own idea; another user's is 404):
//   the idea        its statement; edit (POST /workbench/ideas/:id/edit -> idea_edit(), the function update_idea
//                   calls too), research now (-> idea_research()), create document (the P2b seed, which promotes the
//                   idea through idea_promote()) - and once the refinery's ONE document exists, go to document
//   revisions       every revision, newest last
//   dossier         the dossier source and how many dossiers landed in the room
//   draft           the accreting draft - a field on the idea's room (PUT /workbench/ideas/:id/draft)
//   room            its ONE long-lived room (the Mattermost thread, when there is one, is its inlet)
//   members         every session (an ordinary session: it is in the research home too), podcast and chat engaged
//                   from inside the refinery, and its one document - archive / reopen act on that document (D17)
//   user sources    every source the user added: fold status (held / admitted / lead-only), the scoped
//                   corroboration result, the trail to what was admitted found_via it; remove on a held one
//                   (the document clean-up runs first; no tombstone)
//   context graph   opens the refinery's context-graph panel (RefineryGraphPanel), where hide / unhide live
// Every request is the identity seam's; nothing here names a user.
import { useEffect, useMemo, useState } from "react";
import { api, C, D, get, post, q } from "../../lib/api";
import { setState } from "../../lib/store";
import { statusBadges } from "../../lib/sourceStatus";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { openPanel } from "../../shell/dock";
import { registerPanel, type PanelProps } from "../../shell/registry";
import { openRoom } from "../room/RoomPanels";
import { day } from "./IdeasPanel";
import { buildGraph, layout, neighbourhoods } from "../graph/model";

export const I = "/workbench/ideas";

// ideas and refineries change from more than one panel: a write here re-reads every open idea view and graph
const subs = new Set<() => void>();
export const ideaChanged = () => subs.forEach((f) => f());
function useIdea(id: string | undefined) {
  const [idea, setIdea] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((t) => t + 1);
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  }, []);
  useEffect(() => {
    if (!id) return;
    let live = true;
    get(`${C}/ideas/${q(id)}`).then((v) => live && setIdea(v)).catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [id, tick]);
  return { idea, msg, setMsg };
}

// the fold status as the user reads it (the registry key `active` is the admitted one)
export const foldLabel = (status: string) => (status === "active" ? "admitted" : status);
export function corroborationBadge(u: any): string {
  if (!u.corroboration || u.corroboration.state === "not_run") return "not corroborated yet";
  return u.corroboration.givers ? `corroborated by ${u.corroboration.givers}` : "uncorroborated here";
}

function TextForm(props: { initial: string; label: string; action: string; rows?: number; onSave: (t: string) => Promise<void> }) {
  const [text, setText] = useState(props.initial);
  return (
    <span className="ws-inline-form">
      <textarea aria-label={props.label} data-input={props.action} rows={props.rows ?? 4} value={text} onChange={(e) => setText(e.target.value)} />
      <button type="button" data-action={props.action} onClick={() => props.onSave(text)}>Save</button>
    </span>
  );
}

export function IdeaPanel(p: PanelProps) {
  const id = p.params.idea_id as string | undefined;
  const { idea, msg, setMsg } = useIdea(id);
  const [flags, setFlags] = useState<{ path: string; line: number; form: string; text: string }[]>([]);
  const doc = idea?.refinery?.members?.document ?? null;
  const archived = !!idea?.refinery?.archived;

  const act = async (what: string, f: () => Promise<unknown>) => {
    try {
      await f();
      setMsg(what);
      ideaChanged();
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
      if (e?.body?.documents) setFlags(e.body.documents.flatMap((d: any) => d.flags ?? []));
    }
  };

  const leaves = useMemo<Leaf[]>(() => {
    if (!idea) return [];
    const r = idea.refinery;
    return [
      { key: "idea", label: <span>the idea</span>, badges: [archived ? "refinery archived" : idea.status, `revision ${idea.current_revision}`], detail: <span>{idea.summary}</span> },
      ...idea.revisions.map((v: any) => ({ key: `rev:${v.revision}`, label: <span>revision {v.revision}</span>, badges: [day(v.created_at) ?? ""], detail: <span>{v.summary}</span> })),
      {
        key: "dossier", label: <span>dossier{idea.dossier ? `: ${idea.dossier.title}` : ""}</span>,
        badges: [idea.dossier ? "dossier" : "no dossier yet", `${idea.room.dossiers} in the room`, ...statusBadges(idea.dossier?.lifecycle)],
      },
      { key: "draft", label: <span>the accreting draft</span>, badges: [idea.draft.state], detail: <span data-testid="idea-draft">{idea.draft.text || "(empty)"}</span> },
      {
        key: "room", label: <span>the room</span>, badges: [idea.room.state === "current" ? `${idea.room.entries} entries` : "not opened yet", ...(idea.room.inlet ? ["mattermost inlet"] : [])],
        detail: idea.room.inlet ? <span>bound to the Mattermost thread {idea.room.thread_root} (its inlet)</span> : undefined,
      },
      { key: "graph", label: <span>context graph</span>, badges: [`${r.context_graph.nodes.length} nodes`, `${r.hidden.length} hidden`] },
      {
        key: "document", label: <span>{doc ? `document: ${doc.title || doc.path}` : "no document yet"}</span>,
        badges: [doc ? (archived ? "refinery archived" : "its one document") : "create document"],
      },
      ...idea.sessions.map((s: any) => ({ key: `session:${s.id}`, label: <span data-member="session">{s.query.slice(0, 80) || s.id.slice(0, 8)}</span>, badges: ["session", s.status, s.origin] })),
      ...r.members.podcasts.map((x: string) => ({ key: `podcast:${x}`, label: <span data-member="podcast">podcast {x.slice(0, 8)}</span>, badges: ["podcast"] })),
      ...r.members.chats.map((x: string) => ({ key: `chat:${x}`, label: <span data-member="chat">chat {x.slice(0, 8)}</span>, badges: ["chat"] })),
      ...r.user_sources.map((u: any) => ({
        key: `user:${u.source_id}`, label: <span data-user-source={u.source_id}>{u.title || u.source_id.slice(0, 8)}</span>,
        badges: [foldLabel(u.status), ...statusBadges(u.state === u.status ? null : u.state), corroborationBadge(u), `found via: ${u.found_via.length}`],
        detail: u.found_via.length ? <ul>{u.found_via.map((v: any) => <li key={v.trail_id}>{v.url}</li>)}</ul> : undefined,
      })),
    ];
  }, [idea, doc, archived]);

  const actions = (l: Leaf) => {
    if (!idea) return null;
    if (l.key === "idea") {
      if (archived) return <span className="ws-muted">the refinery rests: reopen it from its document</span>;
      return (
        <>
          <TextForm initial={idea.summary} label="the idea's statement" action="edit-idea"
            onSave={(t) => act("saved as a new revision", () => post(`${I}/${q(idea.id)}/edit`, { summary: t }))} />
          <button type="button" data-action="research-now" onClick={() => act("research queued now", () => post(`${I}/${q(idea.id)}/research-now`))}>Research now</button>
        </>
      );
    }
    if (l.key === "draft") {
      return <TextForm initial={idea.draft.text} label="the accreting draft" action="save-draft" rows={8}
        onSave={(t) => act("draft saved", () => api("PUT", `${I}/${q(idea.id)}/draft`, { text: t }))} />;
    }
    if (l.key === "room") return <button type="button" data-action="open-room" onClick={() => openRoom("idea", idea.id)}>Open the room</button>;
    if (l.key === "graph") return <button type="button" data-action="open-graph" onClick={() => openPanel("refinery-graph", { idea_id: idea.id })}>Open the context graph</button>;
    if (l.key === "dossier" && idea.dossier) {
      return <button type="button" data-action="open-dossier" onClick={() => setState({ reference: { reference_id: null, source_id: idea.dossier.source_id, chunk_idx: 0 } })}>Open</button>;
    }
    if (l.key === "document") {
      if (!doc) {
        return archived ? null : (
          <button type="button" data-action="create-document" onClick={() => act("document created; the idea is promoted", async () => {
            const s = await post(`${D}/seed`, { idea_id: idea.id });
            setState({ documentPath: s.path });
            openPanel("document");
          })}>Create document</button>
        );
      }
      return (
        <>
          <button type="button" data-action="go-to-document" onClick={() => { setState({ documentPath: doc.path }); openPanel("document"); }}>Go to document</button>
          {archived
            ? <button type="button" data-action="open-refinery" onClick={() => act("refinery reopened", () => post(`${D}/refinery/open`, { path: doc.path }))}>Open the refinery</button>
            : <button type="button" data-action="archive-refinery" onClick={() => act("refinery archived (nothing deleted)", () => post(`${D}/refinery/archive`, { path: doc.path }))}>Archive this idea refinery</button>}
        </>
      );
    }
    if (l.key.startsWith("session:")) {
      return <button type="button" data-action="session-flow" onClick={() => openPanel("flow", { session: l.key.slice(8) })}>Research flow</button>;
    }
    if (l.key.startsWith("user:")) {
      const sid = l.key.slice(5);
      const u = idea.refinery.user_sources.find((x: any) => x.source_id === sid);
      return (
        <>
          <button type="button" data-action="cite" onClick={() => setState({ reference: { reference_id: null, source_id: sid, chunk_idx: 0 } })}>Open</button>
          <button type="button" data-action="trail" onClick={() => openPanel("trail", { source: sid })}>Trail</button>
          {u?.state === "held" && (
            <button type="button" data-action="remove" onClick={() => act("removed (held: no tombstone)", async () => {
              setFlags([]);
              await api("DELETE", `${D}/user-sources/${q(sid)}?refinery_id=${q(idea.id)}`);
            })}>Remove</button>
          )}
        </>
      );
    }
    return null;
  };

  return (
    <div className="ws-side ws-idea">
      <Disclosure
        testId="idea-disclosure"
        summary={idea ? <span>idea: {idea.title} <span className="ws-badge">{archived ? "refinery archived" : idea.status}</span></span>
          : <span>{id ? "the idea" : "open an idea from the ideas panel"}</span>}
        leaves={leaves}
        actions={actions}
        empty="nothing here yet"
      />
      {flags.length > 0 && (
        <ul className="ws-flags" data-testid="idea-flags">
          {flags.map((f, i) => <li key={i}>{f.path}{f.line ? ` line ${f.line}` : ""} {f.form}: <code>{f.text}</code></li>)}
        </ul>
      )}
      {msg && <p className="ws-muted" data-testid="idea-msg">{msg}</p>}
    </div>
  );
}

// The refinery's context graph (D17 item 6): the page-graph model (graph/model.ts) scoped to the refinery's subgraph -
// its sessions' sources and claims, its user sources and what its document links. Hide / unhide is a view setting on
// THIS refinery only (POST /contract/ideas/{id}/hidden): it narrows the context of the refinery's sessions and its
// chat; search keeps a hidden source, re-sorted last with a tag; nothing outside the refinery changes.
export function RefineryGraphPanel(p: PanelProps) {
  const id = p.params.idea_id as string | undefined;
  const { idea, msg, setMsg } = useIdea(id);
  const graph = idea?.refinery?.context_graph ?? { nodes: [], links: [] };
  const nid = (n: any) => `${n.kind}:${n.id}`;
  const drawn = useMemo(() => {
    const ids = new Set(graph.nodes.map((n: any) => n.id));
    const g = buildGraph(
      graph.nodes.map((n: any) => ({ id: nid(n), title: n.title, page_class: n.kind, lifecycle: n.state })),
      graph.links.filter((l: any) => ids.has(l.source) && ids.has(l.target)).map((l: any) => {
        const kindOf = (x: string) => graph.nodes.find((n: any) => n.id === x)?.kind ?? "source";
        return { source: `${kindOf(l.source)}:${l.source}`, target: `${kindOf(l.target)}:${l.target}` };
      }),
    );
    const nb = neighbourhoods(g);
    return { g, pos: layout(g, nb.of, { width: 400, height: 260, iterations: 80 }) };
  }, [idea]); // eslint-disable-line react-hooks/exhaustive-deps
  const hidden = new Set(graph.nodes.filter((n: any) => n.hidden).map(nid));
  const leaves: Leaf[] = graph.nodes.map((n: any) => ({
    key: nid(n), label: <span data-graph-node={n.id}>{n.title || n.id}</span>,
    badges: [n.kind, ...statusBadges(n.state === "current" ? null : n.state), ...(n.hidden ? ["hidden"] : [])],
  }));
  const actions = (l: Leaf) => {
    const n = graph.nodes.find((x: any) => nid(x) === l.key);
    if (!n || !idea) return null;
    const set = (h: boolean) => post(`${C}/ideas/${q(idea.id)}/hidden`, { node_kind: n.kind, node_ref: n.id, hidden: h })
      .then(() => { setMsg(h ? "hidden in this refinery only" : "unhidden"); ideaChanged(); })
      .catch((e) => setMsg(String((e as Error).message)));
    return n.hidden
      ? <button type="button" data-action="unhide" onClick={() => set(false)}>Unhide</button>
      : <button type="button" data-action="hide" onClick={() => set(true)}>Hide</button>;
  };
  return (
    <div className="ws-side ws-refinery-graph">
      <Disclosure
        testId="refinery-graph-disclosure"
        summary={<span>context graph{idea ? `: ${graph.nodes.length} nodes, ${hidden.size} hidden` : ""}</span>}
        leaves={leaves}
        actions={actions}
        empty="nothing in the refinery's graph yet"
      />
      {drawn.g.nodes.length > 0 && (
        <svg className="ws-refinery-canvas" viewBox="0 0 400 260" data-testid="refinery-graph-canvas" role="img" aria-label="the refinery's context graph">
          {drawn.g.edges.map((e) => {
            const a = drawn.pos.get(e.source), b = drawn.pos.get(e.target);
            return a && b ? <line key={`${e.source}>${e.target}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeOpacity={0.3} /> : null;
          })}
          {drawn.g.nodes.map((n) => {
            const pt = drawn.pos.get(n.id);
            return pt ? <circle key={n.id} cx={pt.x} cy={pt.y} r={5} data-node={n.id} data-hidden={hidden.has(n.id) ? "1" : "0"}
              fill="currentColor" fillOpacity={hidden.has(n.id) ? 0.2 : 0.8}><title>{n.title}</title></circle> : null;
          })}
        </svg>
      )}
      {msg && <p className="ws-muted" data-testid="refinery-graph-msg">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "idea", version: 1, title: "Idea", kind: "side", component: IdeaPanel, position: "right" });
registerPanel({ id: "refinery-graph", version: 1, title: "Context graph", kind: "side", component: RefineryGraphPanel, position: "right" });
