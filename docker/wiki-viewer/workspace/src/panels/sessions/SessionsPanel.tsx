// Running sessions (research-workbench P4b, D17): every research job, whatever started it, is ONE card
// of ONE shape - its origin badge, its question (empty on another user's session: the original prompt
// is its owner's), its phase, the artifact it is on, what it waits on, the next steering point (where a
// steer sent now lands) and its branch tree with open / closed branches. Selecting a card shows the
// link back to its inlet (where the job carries one), its live events and - for a viewer who may act
// (its owner; a service's session: an admin) - steer, narrow, add a source and cancel.
// A steering stage offers "steer here"; a due-process stage (recall, screening, fetching, judging,
// filing) never does. A steer is shown as a pending branch from the server's own answer, and the
// stream's next card carries it too; a refused steer says why (never a silent acceptance).
import { useEffect, useMemo, useState } from "react";
import { ApiError, C, get, post, q } from "../../lib/api";
import { setState } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { openPanel } from "../../shell/dock";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";
import { openStream } from "./stream";
import "./sessions.css";

export interface Branch {
  id: string;
  parent_job_id: string | null;
  branch_kind: string;
  status: string;
  open: boolean;
  pending: boolean;
  rooted_step_id: string | null;
  query: string;
}
export interface Card {
  id: string;
  status: string;
  state: string;
  origin: string;
  badge: { key: string; label: string };
  link: { kind: string; href: string | null; panel: string | null; params: Record<string, string> } | null;
  query: string;
  phase: string;
  current_artifact: { kind: string; label: string };
  waiting_on: { kind: string; detail: string };
  next_steering_point: { step_id: string | null; phase: string } | null;
  tree: Branch[];
  can_act: boolean;
}
export interface SessionEvent {
  id: number;
  job_id: string;
  step_id: string | null;
  type: string;
  kind: string;
  payload: Record<string, any> | null;
  trail: Record<string, any> | null;
}

// A steer affordance belongs to a STEERING stage only (P4a: kind steering | due_process).
export const steerable = (e: SessionEvent) => e.type === "stage" && e.kind === "steering" && !!e.step_id;

function eventLabel(e: SessionEvent): string {
  if (e.type === "stage") return `${e.payload?.phase ?? "stage"}${e.step_id ? ` (${e.step_id})` : ""}`;
  if (e.type === "source") return `source ${e.payload?.url ?? ""} - ${e.trail?.kind ?? e.payload?.outcome ?? ""}`;
  if (e.type === "human_steer") return `steered${e.payload?.text ? `: ${e.payload.text}` : ""}`;
  if (e.type === "branch_open") return "branch opened";
  if (e.type === "branch_close") return "branch closed";
  return e.type;
}

export function LinkBack(props: { card: Card; onSession: (id: string) => void }) {
  const l = props.card.link;
  if (!l) return <span className="ws-muted" data-link="none">{props.card.badge.label}: no link back</span>;
  if (l.kind === "external" && l.href) {
    return <a data-link="external" href={l.href} target="_blank" rel="noopener noreferrer">open in {props.card.badge.label}</a>;
  }
  const go = () => {
    if (l.panel === "document" && l.params.path) {
      setState({ documentPath: l.params.path });
      openPanel("document");
    } else if (l.panel === "sessions" && l.params.session) props.onSession(l.params.session);
    else if (l.panel) openPanel(l.panel, l.params);
  };
  const label = l.panel === "refinery" ? "open the refinery room" : l.panel === "document" ? "open the document" : "open this session";
  return <button type="button" data-link={l.panel ?? ""} onClick={go}>{label}</button>;
}

export function CardSummary({ card: c }: { card: Card }) {
  const nsp = c.next_steering_point;
  return (
    <span className="ws-card" data-card={c.id} data-origin={c.badge.key}>
      <span className="ws-origin-badge" data-badge={c.badge.key}>{c.badge.label}</span>
      <span className="ws-card-query">{c.query || "(another user's session)"}</span>
      <span className="ws-card-row" data-field="phase">phase: {c.phase}</span>
      <span className="ws-card-row" data-field="artifact">on: {c.current_artifact.label}</span>
      <span className="ws-card-row" data-field="waiting">waiting on: {c.waiting_on.detail}</span>
      <span className="ws-card-row" data-field="next-steer">
        next steering point: {nsp ? `${nsp.phase}${nsp.step_id ? ` (${nsp.step_id})` : ""}` : "none yet"}
      </span>
      <span className="ws-tree" data-testid="tree">
        {c.tree.map((b) => (
          <span key={b.id} className={`ws-branch${b.open ? " ws-branch-open" : " ws-branch-closed"}${b.pending ? " ws-branch-pending" : ""}`}
            data-branch={b.id} data-open={b.open ? "1" : "0"} data-pending={b.pending ? "1" : "0"} data-kind={b.branch_kind}
            style={{ paddingLeft: b.parent_job_id ? 12 : 0 }}>
            {b.branch_kind} · {b.pending ? "pending" : b.open ? "open" : "closed"}{b.query ? ` · ${b.query}` : ""}
          </span>
        ))}
      </span>
    </span>
  );
}

export function SessionsPanel(p: PanelProps) {
  const focus = (p.params.session as string | undefined) ?? null;
  const [cards, setCards] = useState<Card[]>([]);
  const [sel, setSel] = useState<string | null>(focus);
  const [events, setEvents] = useState<Record<string, SessionEvent[]>>({});
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  const [form, setForm] = useState({ text: "", step: "", deny: "", maxFetch: "", url: "", content: "" });
  useEffect(() => setSel(focus), [focus]);

  // the list: refreshed every few seconds while the panel is open
  useEffect(() => {
    let live = true;
    get(`${C}/sessions?state=recent&limit=100`)
      .then((r) => live && setCards(r.sessions ?? []))
      .catch((e) => live && setMsg(String((e as Error).message)));
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [tick]);

  // the selected session's stream: each `card` event replaces the card and adds the tree's new events
  useEffect(() => {
    if (!sel) return;
    return openStream(`${C}/sessions/${q(sel)}/stream`, (m) => {
      if (m.event !== "card" || !m.data?.card) return;
      const card = m.data.card as Card;
      setCards((cs) => cs.some((c) => c.id === card.id) ? cs.map((c) => (c.id === card.id ? card : c)) : [card, ...cs]);
      const evs = (m.data.events ?? []) as SessionEvent[];
      if (evs.length) setEvents((all) => ({ ...all, [card.id]: [...(all[card.id] ?? []), ...evs] }));
    });
  }, [sel]);

  const replace = (card: Card) => setCards((cs) => cs.map((c) => (c.id === card.id ? card : c)));
  const steer = async (c: Card, body: Record<string, unknown>, what: string) => {
    const step = form.step || c.next_steering_point?.step_id;
    if (!step) return setMsg("no steering point yet: a steer lands at a steering stage");
    try {
      const r = await post(`${C}/sessions/${q(c.id)}/steer`, { step_id: step, ...body });
      replace(r.card);
      setMsg(`${what} accepted: branch ${String(r.steer.child_job_id).slice(0, 8)} is pending`);
      setForm({ text: "", step: "", deny: "", maxFetch: "", url: "", content: "" });
    } catch (e) {
      setMsg(`${what} refused: ${e instanceof ApiError ? e.message : String(e)}`);
    }
  };
  const cancel = async (c: Card) => {
    try {
      const r = await post(`${C}/sessions/${q(c.id)}/cancel`, { reason: "cancelled from the session card" });
      setMsg(`cancel: ${r.status}`);
      setTick((x) => x + 1);
    } catch (e) {
      setMsg(`cancel refused: ${e instanceof ApiError ? e.message : String(e)}`);
    }
  };

  const leaves = useMemo<Leaf[]>(() => cards.map((c) => ({
    key: c.id,
    label: <CardSummary card={c} />,
    badges: [c.status],
    detail: (
      <div className="ws-card-detail">
        <div className="ws-card-links">
          <LinkBack card={c} onSession={setSel} />{" "}
          <button type="button" data-open-flow={c.id} onClick={() => openPanel("flow", { session: c.id })}>research flow</button>
        </div>
        <ol className="ws-events" data-testid="events">
          {(events[c.id] ?? []).map((e) => (
            <li key={e.id} data-event={e.id} data-kind={e.kind} data-type={e.type}>
              <span className={`ws-event-kind ws-event-${e.kind}`}>{e.kind === "steering" ? "steering" : "due process"}</span> {eventLabel(e)}
              {c.can_act && steerable(e) && (
                <button type="button" data-action="steer-at" data-step={e.step_id ?? ""} onClick={() => setForm((f) => ({ ...f, step: e.step_id ?? "" }))}>
                  steer here
                </button>
              )}
            </li>
          ))}
        </ol>
      </div>
    ),
  })), [cards, events]);

  const actions = (leaf: Leaf) => {
    const c = cards.find((x) => x.id === leaf.key);
    if (!c) return null;
    if (!c.can_act) {
      return <span className="ws-muted" data-testid="no-act">steering and cancelling: its owner (a service's session: an admin)</span>;
    }
    const at = form.step || c.next_steering_point?.step_id || "";
    const field = (k: keyof typeof form, ph: string) => (
      <input data-input={k} placeholder={ph} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    );
    return (
      <div className="ws-card-actions">
        <div>steers land at: {at || "no steering point yet"}</div>
        <div>{field("text", "steer: what should it look at?")}
          <button type="button" data-action="steer" disabled={!at || !form.text.trim()} onClick={() => steer(c, { text: form.text }, "steer")}>steer</button></div>
        <div>{field("deny", "narrow: leave out a site")}{field("maxFetch", "at most N fetches")}
          <button type="button" data-action="narrow" disabled={!at || (!form.deny.trim() && !form.maxFetch.trim())} onClick={() => steer(c, {
            text: form.text.trim() || `narrow${form.deny ? `: without ${form.deny}` : ""}${form.maxFetch ? `, at most ${form.maxFetch} fetches` : ""}`,
            contract: {
              ...(form.deny.trim() ? { sources: { deny: [form.deny.trim()] } } : {}),
              ...(form.maxFetch.trim() ? { budget: { max_fetch: parseInt(form.maxFetch, 10) } } : {}),
            },
          }, "narrow")}>narrow</button></div>
        <div>{field("url", "add a source: its URL")}{field("content", "its text (blank: fetched)")}
          <button type="button" data-action="add-source" disabled={!at || !form.url.trim()} onClick={() => steer(c, {
            text: form.text.trim() || `add the source ${form.url.trim()}`,
            add_source: { url: form.url.trim(), ...(form.content.trim() ? { content: form.content } : {}) },
          }, "add a source")}>add source</button></div>
        <div><button type="button" data-action="cancel" onClick={() => cancel(c)}>cancel the session</button></div>
      </div>
    );
  };

  const running = cards.filter((c) => c.state === "loading").length;
  return (
    <div className="ws-side ws-sessions">
      <Disclosure
        testId="sessions-disclosure"
        summary={<span>{running} running session{running === 1 ? "" : "s"}{cards.length > running ? `, ${cards.length - running} recent` : ""}</span>}
        leaves={leaves}
        actions={actions}
        open={!!focus}
        selected={focus}
        onSelect={(l) => setSel(l?.key ?? null)}
        empty="no running sessions"
      />
      {msg && <p className="ws-muted" data-testid="sessions-msg">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "sessions", version: 1, title: "Sessions", kind: "side", component: SessionsPanel, position: "right" });
registerNav({ id: "sessions", version: 1, label: "Sessions", order: 45, panel: "sessions" });
