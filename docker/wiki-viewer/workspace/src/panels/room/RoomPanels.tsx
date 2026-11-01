// The research room and its scoped chat (research-workbench rw-p8a3-room, D2 / D17 item 3). Chat IS the
// room (operator 2026-11-01): both panels read ONE per-user room store through /workbench/rooms, and a chat
// message is a room entry - there is no chat kept anywhere else.
//
//   room   the conversation record of an idea (its refinery) or of a research session: what it is about (a
//          session's origin badge and the link back to its inlet - a Mattermost thread is linked, never read
//          or mirrored), its transcript (questions, answers with the sources they were given, dossiers) and
//          the idea's accreting draft
//   chat   the room's scoped chat: its source filter (the whole knowledge database, or only listed sources -
//          an enabled filter with no source gives no context at all) and the question box. With the chat's
//          LiteLLM key blank (as shipped) the server refuses with one fixed message, shown as it is.
// Both follow the side-panel at-rest rule (Disclosure): a summary first, leaves on selection, actions only
// on a selected leaf. Open them with openRoom(kind, id).
import { useEffect, useMemo, useState } from "react";
import { ApiError, api, get, post, q } from "../../lib/api";
import { setState } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { openPanel } from "../../shell/dock";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";
import { LinkBack, type Card } from "../sessions/SessionsPanel";

export const R = "/workbench/rooms";

export interface Entry {
  id: string;
  seq: number;
  kind: "user" | "assistant" | "dossier";
  body: string;
  context: { source_id: string; chunk: number; held: boolean }[];
  created_at: string;
}
export interface RoomView {
  room: { id: string; subject: { kind: string; id: string }; scope: { enabled: boolean; sources: string[] }; draft: string };
  subject: { kind: string; id: string; title?: string; status?: string; card?: Pick<Card, "badge" | "link" | "query" | "status"> | null };
  chat: { state: "on" | "off" | "refused" };
  entries: Entry[];
}

// both panels re-read when either one changed the room
const subs = new Set<() => void>();
export const roomChanged = () => subs.forEach((f) => f());

export function openRoom(kind: "idea" | "session", id: string) {
  openPanel("room", { subject_kind: kind, subject_id: id });
  openPanel("chat", { subject_kind: kind, subject_id: id });
}

// The caller's room on the panel's subject (opened on first ask), re-read on every change.
function useRoom(p: PanelProps) {
  const kind = p.params.subject_kind as string | undefined;
  const id = p.params.subject_id as string | undefined;
  const [view, setView] = useState<RoomView | null>(null);
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
    if (!kind || !id) return;
    let live = true;
    (async () => {
      const opened = await post(R, { subject_kind: kind, subject_id: id });
      const v = await get<RoomView>(`${R}/${q(opened.room.id)}`);
      if (live) setView(v);
    })().catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [kind, id, tick]);
  return { view, msg, setMsg, kind, id };
}

const subjectLabel = (v: RoomView) =>
  v.subject.kind === "idea" ? `idea: ${v.subject.title || "(untitled)"}` : `session: ${v.subject.card?.query || "(another user's session)"}`;

export function RoomPanel(p: PanelProps) {
  const { view, msg, kind } = useRoom(p);
  const leaves = useMemo<Leaf[]>(() => {
    if (!view) return [];
    const out: Leaf[] = [{ key: "subject", label: <span>{subjectLabel(view)}</span>, badges: [view.subject.kind === "idea" ? view.subject.status ?? "" : view.subject.card?.badge.label ?? "session"].filter(Boolean) }];
    if (view.room.draft) out.push({ key: "draft", label: <span>the draft</span>, detail: <pre className="ws-room-draft">{view.room.draft}</pre> });
    for (const e of view.entries) {
      out.push({
        key: `entry:${e.id}`,
        label: <span data-entry={e.id} data-kind={e.kind}>{e.kind === "user" ? "you" : e.kind === "assistant" ? "answer" : "dossier"}: {e.body.slice(0, 80)}</span>,
        badges: e.kind === "assistant" ? [`${e.context.length} passage${e.context.length === 1 ? "" : "s"}`] : [],
        detail: <div className="ws-room-body">{e.body}</div>,
      });
    }
    return out;
  }, [view]);
  const actions = (l: Leaf) => {
    if (!view) return null;
    if (l.key === "subject") {
      if (view.subject.kind === "session" && view.subject.card) {
        return <LinkBack card={view.subject.card as Card} onSession={(s) => openPanel("sessions", { session: s })} />;
      }
      if (view.subject.kind === "idea") return <button type="button" data-action="open-refinery" onClick={() => openPanel("refinery", { idea_id: view.subject.id })}>open the refinery</button>;
      return null;
    }
    if (l.key.startsWith("entry:")) {
      const e = view.entries.find((x) => `entry:${x.id}` === l.key);
      if (!e?.context.length) return null;
      return (
        <>
          {[...new Map(e.context.map((c) => [c.source_id, c])).values()].map((c) => (
            <button key={c.source_id} type="button" data-open-source={c.source_id}
              onClick={() => setState({ reference: { reference_id: null, source_id: c.source_id, chunk_idx: c.chunk } })}>
              source {c.source_id.slice(0, 8)}{c.held ? " (held)" : ""}
            </button>
          ))}
        </>
      );
    }
    return null;
  };
  return (
    <div className="ws-side ws-room" data-testid="room-panel">
      <Disclosure
        testId="room-disclosure"
        summary={view ? <span>room · {subjectLabel(view)} <span className="ws-badge">{view.entries.length} entr{view.entries.length === 1 ? "y" : "ies"}</span></span>
          : <span>{kind ? "opening the room" : "no room open: open one from a refinery or a session"}</span>}
        leaves={leaves}
        actions={actions}
        empty="nothing in the room yet"
      />
      {msg && <p className="ws-muted" data-testid="room-msg">{msg}</p>}
    </div>
  );
}

export function ChatPanel(p: PanelProps) {
  const { view, msg, setMsg } = useRoom(p);
  const [text, setText] = useState("");
  const [only, setOnly] = useState(false);
  const [list, setList] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!view) return;
    setOnly(view.room.scope.enabled);
    setList(view.room.scope.sources.join("\n"));
  }, [view?.room.id, view?.room.scope.enabled, view?.room.scope.sources.join(",")]);
  const scopeText = !view ? "" : !view.room.scope.enabled ? "the whole knowledge database"
    : view.room.scope.sources.length === 0 ? "no sources (no context)" : `${view.room.scope.sources.length} listed source${view.room.scope.sources.length === 1 ? "" : "s"}`;
  const off = view && view.chat.state !== "on";
  const leaves: Leaf[] = view ? [
    { key: "scope", label: <span>scope: {scopeText}</span>, badges: [view.subject.kind === "idea" ? "refinery: hidden sources left out" : "knowledge database"] },
    { key: "ask", label: <span>ask in this room</span>, badges: [off ? "chat off" : "chat on"] },
  ] : [];
  const saveScope = async () => {
    if (!view) return;
    try {
      const sources = list.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      await api("PUT", `${R}/${q(view.room.id)}/scope`, { enabled: only, sources: only ? sources : [] });
      setMsg(only && !sources.length ? "scope: no sources - the chat gets no context" : "scope saved");
      roomChanged();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  };
  const ask = async () => {
    if (!view || !text.trim()) return;
    setBusy(true);
    try {
      await post(`${R}/${q(view.room.id)}/chat`, { text });
      setText("");
      setMsg("");
      roomChanged();
    } catch (e) {
      // chat off: the server's one fixed message, shown as it is
      setMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const actions = (l: Leaf) => {
    if (!view) return null;
    if (l.key === "scope") {
      return (
        <div className="ws-chat-scope">
          <label><input type="checkbox" data-field="only" checked={only} onChange={(e) => setOnly(e.target.checked)} /> only these sources</label>
          {only && <textarea data-field="sources" placeholder="source ids, one per line (none = no context)" value={list} onChange={(e) => setList(e.target.value)} />}
          <button type="button" data-action="save-scope" onClick={saveScope}>save scope</button>
        </div>
      );
    }
    if (l.key === "ask") {
      return (
        <div className="ws-chat-ask">
          <textarea data-field="question" placeholder={off ? "chat is off" : "ask about the sources in scope"} value={text} onChange={(e) => setText(e.target.value)} />
          <button type="button" data-action="ask" disabled={busy || !text.trim()} onClick={ask}>ask</button>
        </div>
      );
    }
    return null;
  };
  return (
    <div className="ws-side ws-chat" data-testid="chat-panel">
      <Disclosure
        testId="chat-disclosure"
        summary={view ? <span>scoped chat · {scopeText}{off ? " · chat off" : ""}</span> : <span>no room open</span>}
        leaves={leaves}
        actions={actions}
        empty="no room open"
      />
      {msg && <p className="ws-muted" data-testid="chat-msg">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "room", version: 1, title: "Room", kind: "side", component: RoomPanel, position: "right" });
registerPanel({ id: "chat", version: 1, title: "Scoped chat", kind: "side", component: ChatPanel, position: "below" });
registerNav({ id: "room", version: 1, label: "Room", order: 55, panel: "room" });
