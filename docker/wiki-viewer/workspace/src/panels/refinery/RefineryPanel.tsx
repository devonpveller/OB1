// The open document's idea refinery (D17 items 5-6): its state, the room, its members and the user
// source list (held / active / lead-only), with the document-level actions - start (greyed out until
// the document carries an idea), archive (deletes nothing; the document is tagged "refinery
// archived" and stays editable), reopen (never a second refinery). Removing a held source the
// document links is blocked; the flags say where, and the user resolves them by hand. Replace is
// type-conditional (a link refetches; a file is replaced by hand).
import { useEffect, useMemo, useState } from "react";
import { api, C, D, get, post, q } from "../../lib/api";
import { setState, useWorkspace } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";

interface Flag {
  path: string;
  line: number;
  form: string;
  text: string;
}

export function RefineryPanel(p: PanelProps) {
  const path = useWorkspace((s) => s.documentPath);
  const [dstate, setDstate] = useState<any>(null);
  const [idea, setIdea] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const [flags, setFlags] = useState<Flag[]>([]);
  const [tick, setTick] = useState(0);
  const ideaParam = p.params.idea_id as string | undefined;
  useEffect(() => {
    let live = true;
    (async () => {
      const st = path ? await get(`${D}/state?path=${q(path)}`) : null;
      const id = ideaParam ?? st?.refinery?.id;
      const i = id ? await get(`${C}/ideas/${q(id)}`) : null;
      if (live) {
        setDstate(st);
        setIdea(i);
      }
    })().catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [path, ideaParam, tick]);
  const refresh = () => setTick((t) => t + 1);

  const leaves = useMemo<Leaf[]>(() => {
    const docLeaf: Leaf[] = path ? [{
      key: "document", label: <span>this document</span>,
      badges: dstate?.refinery ? [dstate.refinery.archived ? "refinery archived" : "tethered"] : dstate?.carries_idea ? ["carries an idea"] : ["no idea yet"],
    }] : [];
    if (!idea) return docLeaf;
    const room = idea.room;
    return [
      ...docLeaf,
      { key: "room", label: <span>the room</span>, badges: [room.state], detail: <span>{room.note}{room.location ? ` (${room.location})` : ""}</span> },
      ...idea.refinery.members.sessions.map((s: string) => ({ key: `session:${s}`, label: <span>session {s.slice(0, 8)}</span>, badges: ["session"] })),
      ...idea.refinery.user_sources.map((u: any) => ({
        key: `user:${u.source_id}`, label: <span data-user-source={u.source_id}>{u.title}</span>, badges: [u.status, `rev ${u.revision}`, u.url ? "link" : "file"],
      })),
    ];
  }, [idea, dstate, path]);

  const actions = (l: Leaf) => {
    if (l.key === "document") {
      const r = dstate?.refinery;
      return (
        <>
          {!r && (
            <button type="button" data-action="start-refinery" disabled={!dstate?.carries_idea} title={dstate?.carries_idea ? "" : "add an idea to the document to get started"} onClick={() => docAction("start")}>
              Start refinery
            </button>
          )}
          {r && !r.archived && <button type="button" data-action="archive-refinery" onClick={() => docAction("archive")}>Archive this idea refinery</button>}
          {r?.archived && <button type="button" data-action="open-refinery" onClick={() => docAction("open")}>Open the refinery</button>}
        </>
      );
    }
    if (l.key === "room") return idea.room.location ? <span className="ws-muted">the room opens in the workspace with P8a</span> : null;
    if (l.key.startsWith("user:")) {
      const sid = l.key.slice(5);
      const u = idea.refinery.user_sources.find((x: any) => x.source_id === sid);
      return (
        <>
          <button type="button" data-action="cite" onClick={() => setState({ reference: { reference_id: null, source_id: sid, chunk_idx: 0 } })}>Open</button>
          {u.state === "held" && (
            <button type="button" data-action="replace" onClick={async () => {
              try {
                const content = u.url ? undefined : window.prompt("Paste the replacement contents (a new source; this document's links move to it)") ?? undefined;
                if (!u.url && !content) return;
                const r = await post(`${D}/user-sources/${sid}/replace`, { path, content });
                setMsg(r.kind === "link" ? (r.changed ? `refetched: revision ${r.revision}` : "the link's contents are unchanged") : "replaced by a new source");
                refresh();
              } catch (e) {
                setMsg(String((e as Error).message));
              }
            }}>Replace</button>
          )}
          {u.state === "held" && (
            <button type="button" data-action="remove" onClick={async () => {
              try {
                await api("DELETE", `${D}/user-sources/${sid}?refinery_id=${q(idea.id)}`);
                setFlags([]);
                setMsg("removed (it was held by nothing)");
                refresh();
              } catch (e: any) {
                const docs = e.body?.documents ?? [];
                setFlags(docs.flatMap((d: any) => d.flags));
                setMsg("blocked: a user document links this source - resolve the flagged places by hand, then remove it");
              }
            }}>Remove</button>
          )}
        </>
      );
    }
    return null;
  };

  const docAction = async (what: "start" | "archive" | "open") => {
    try {
      await post(`${D}/refinery/${what}`, { path });
      setMsg(what === "start" ? "refinery started" : what === "archive" ? "refinery archived" : "refinery reopened");
      setState({ documentRev: Date.now() });
      refresh();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  };

  const ref = dstate?.refinery;
  return (
    <div className="ws-side ws-refinery">
      <Disclosure
        testId="refinery-disclosure"
        summary={idea
          ? <span>refinery: {idea.title} <span className="ws-badge">{ref?.archived ? "refinery archived" : idea.status}</span></span>
          : <span>no refinery for this document</span>}
        leaves={leaves}
        actions={actions}
        empty="nothing in the refinery yet"
      />
      {flags.length > 0 && (
        <ul className="ws-flags" data-testid="flags">
          {flags.map((f, i) => (
            <li key={i}>
              <button type="button" onClick={() => setState({ documentPath: f.path })}>{f.path}{f.line ? ` line ${f.line}` : ""}</button> {f.form}: <code>{f.text}</code>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="ws-muted" data-testid="refinery-msg">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "refinery", version: 1, title: "Refinery", kind: "side", component: RefineryPanel, position: "right" });
registerNav({ id: "refinery", version: 1, label: "Refinery", order: 50, panel: "refinery" });
