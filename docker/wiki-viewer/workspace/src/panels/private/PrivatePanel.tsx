// My private material (rw-owner-private-view, plan 08 PD-PV, slot 480): the owner's own private claims (and the shared
// claims carrying their private link, beside the shared sources), search over their moved email bodies and podcast
// transcripts (text, or semantic over the kept embeddings), and their research jobs seeded with private material, with
// the original question. Everything comes from GET /workbench/contract/private/* - the workbench answers the signed-in
// owner only (or its default identity while sign-in is off), and anyone else an empty list.
// KEPT APART, on purpose:
//   * a fixed banner says it is private and never feeds the wiki, the digest, research or shared search; every row
//     carries a Private chip;
//   * the data lives in this component's state only - never the workspace store, never localStorage (the dock keeps
//     only the panel's params, and this panel puts nothing in them);
//   * there is no cite, insert-into-document, research-from or share action;
//   * a snippet is escaped first, and only then are the inert <<HL>> markers made bold.
import { useEffect, useState } from "react";
import { api, ApiError, C, get, q } from "../../lib/api";
import { currentMe } from "../../lib/auth";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";

const P = `${C}/private`;

interface Src { id: string; title: string; kind: string; created_at: string }
interface PClaim {
  id: string; kind: string; text: string; status: string; epistemic_tag: string; confidence: number; contradicted: boolean; created_at: string;
  private_sources: Src[]; private_parents: { id: string; text: string }[]; shared_sources: { id: string; title: string; url: string }[];
}
interface Hit { source_id: string; title: string; kind: string; created_at: string; idx: number; snippet: string; score: number }
interface Job { id: string; root_job_id: string | null; created_at: string; state: string; query: string | null }
interface JobText { id: string; query: string | null; result: Record<string, unknown> | null; progress: Record<string, unknown> | null; error: string | null }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const highlight = (s: string) => esc(s).replace(/&lt;&lt;HL&gt;&gt;/g, "<b>").replace(/&lt;&lt;\/HL&gt;&gt;/g, "</b>");

const Chip = () => <span className="ws-tag" data-private="chip">Private</span>;

function SignIn({ need }: { need: boolean }) {
  return need ? <p className="ws-muted" data-testid="private-sign-in">Sign in to see your private material.</p> : null;
}

function Claims() {
  const [kind, setKind] = useState("all");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<PClaim[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [need, setNeed] = useState(false);
  const load = async (more = false) => {
    const r = await get(`${P}/claims?kind=${q(kind)}${text ? `&q=${q(text)}` : ""}${more && next ? `&before=${q(next)}` : ""}`).catch(() => ({ claims: [], next: null }));
    setRows(more ? [...rows, ...r.claims] : r.claims);
    setNext(r.next ?? null);
    setNeed(!!r.sign_in_required);
  };
  useEffect(() => { load(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div data-testid="private-claims">
      <form className="ws-inline-form" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <select value={kind} onChange={(e) => setKind(e.target.value)} data-testid="private-claims-kind">
          <option value="all">all</option><option value="private">private</option><option value="mixed">mixed (a shared claim with my private link)</option>
        </select>
        <input type="search" placeholder="filter my claims" value={text} onChange={(e) => setText(e.target.value)} data-testid="private-claims-q" />
      </form>
      <SignIn need={need} />
      {rows.length === 0 && !need && <p className="ws-muted">No private claims.</p>}
      <ul className="ws-list">
        {rows.map((c) => (
          <li key={c.id} data-claim={c.id}>
            <Chip /> <span className="ws-tag">{c.kind}</span> <span className="ws-tag">{c.status}</span>{" "}
            <button type="button" className="ws-link" onClick={() => setOpen(open === c.id ? null : c.id)}>{c.text}</button>
            {open === c.id && (
              <div className="ws-detail" data-testid="private-claim-detail">
                <p className="ws-muted">{c.epistemic_tag} - confidence {c.confidence.toFixed(2)}{c.contradicted ? " - contradicted" : ""}</p>
                <p>My private sources:</p>
                <ul>{c.private_sources.map((s) => <li key={s.id} data-private-source={s.id}><Chip /> {s.kind}: {s.title}</li>)}</ul>
                {c.private_parents.length > 0 && <><p>Drawn from my private claims:</p><ul>{c.private_parents.map((p) => <li key={p.id}><Chip /> {p.text}</li>)}</ul></>}
                {c.kind === "mixed" && <><p>Shared sources (as everyone sees them):</p><ul>{c.shared_sources.map((s) => <li key={s.id} data-shared-source={s.id}>{s.title}</li>)}</ul></>}
              </div>
            )}
          </li>
        ))}
      </ul>
      {next && <button type="button" onClick={() => load(true)}>More</button>}
    </div>
  );
}

function Search() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState("text");
  const [hits, setHits] = useState<Hit[]>([]);
  const [msg, setMsg] = useState("");
  const [body, setBody] = useState<{ id: string; title: string; content: string } | null>(null);
  const run = async () => {
    setMsg("");
    const r = await api("GET", `${P}/sources?mode=${q(mode)}&q=${q(text)}`).catch((e) => ({ status: e instanceof ApiError ? e.status : 0, data: { hits: [] } as any }));
    if (r.status === 503) { setHits([]); return setMsg("Semantic search is not available."); }
    setHits(r.data?.hits ?? []);
    if (r.data?.sign_in_required) setMsg("Sign in to see your private material.");
  };
  const openSource = async (id: string) => {
    const r = await get(`/workbench/sources/${q(id)}`).catch(() => null);
    setBody(r?.source ? { id, title: r.source.title ?? "", content: r.source.content ?? "" } : null);
  };
  return (
    <div data-testid="private-search">
      <form className="ws-inline-form" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <input type="search" placeholder="search my mail bodies and transcripts" value={text} onChange={(e) => setText(e.target.value)} data-testid="private-search-q" />
        <select value={mode} onChange={(e) => setMode(e.target.value)} data-testid="private-search-mode"><option value="text">text</option><option value="semantic">semantic</option></select>
      </form>
      {msg && <p className="ws-muted" data-testid="private-search-msg">{msg}</p>}
      <ul className="ws-list">
        {hits.map((h) => (
          <li key={`${h.source_id}:${h.idx}`} data-hit={h.source_id}>
            <Chip /> <span className="ws-tag">{h.kind}</span>{" "}
            <button type="button" className="ws-link" onClick={() => openSource(h.source_id)}>{h.title || "(untitled)"}</button>
            <div className="ws-muted" dangerouslySetInnerHTML={{ __html: highlight(h.snippet) }} />
          </li>
        ))}
      </ul>
      {body && (
        <div className="ws-detail" data-testid="private-source-body">
          <p><Chip /> {body.title}</p>
          <pre className="ws-pre">{body.content}</pre>
        </div>
      )}
    </div>
  );
}

function Research() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState<JobText | null>(null);
  const [need, setNeed] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  const load = async (more = false) => {
    const r = await get(`${P}/jobs${more && next ? `?before=${q(next)}` : ""}`).catch(() => ({ jobs: [], next: null }));
    setJobs(more ? [...jobs, ...(r.jobs ?? [])] : (r.jobs ?? []));
    setNext(r.next ?? null);
    setNeed(!!r.sign_in_required);
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const show = async (id: string) => setOpen((await get(`${P}/jobs/${q(id)}`).catch(() => null))?.job ?? null);
  return (
    <div data-testid="private-research">
      <SignIn need={need} />
      {jobs.length === 0 && !need && <p className="ws-muted">No research seeded with private material.</p>}
      <ul className="ws-list">
        {jobs.map((j) => (
          <li key={j.id} data-job={j.id}>
            <Chip /> <span className="ws-tag">{j.state}</span>{" "}
            <button type="button" className="ws-link" onClick={() => show(j.id)}>{j.query ?? "(no question)"}</button>
          </li>
        ))}
      </ul>
      {next && <button type="button" onClick={() => load(true)}>More</button>}
      {open && (
        <div className="ws-detail" data-testid="private-job">
          <p><Chip /> {open.query}</p>
          {open.error && <p className="ws-muted">error: {open.error}</p>}
          {open.progress && <pre className="ws-pre">{JSON.stringify(open.progress, null, 2)}</pre>}
          {open.result && <pre className="ws-pre">{JSON.stringify(open.result, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

export function PrivatePanel(_p: PanelProps) {
  const [tab, setTab] = useState<"claims" | "search" | "research">("claims");
  const views = currentMe()?.private_views;
  return (
    <div className="ws-side ws-private" data-testid="private-panel">
      <p className="ws-banner" data-testid="private-banner">
        Private: only you can see this. It never feeds the wiki, the digest, research or shared search.
      </p>
      {views === "default-identity" && (
        <p className="ws-muted" data-testid="private-default-identity">Sign-in is off: this view is served to the workbench's default user.</p>
      )}
      <div className="ws-tabs" role="tablist">
        {(["claims", "search", "research"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} data-tab={t} onClick={() => setTab(t)}>
            {t === "claims" ? "Claims" : t === "search" ? "Search" : "Research"}
          </button>
        ))}
      </div>
      {tab === "claims" && <Claims />}
      {tab === "search" && <Search />}
      {tab === "research" && <Research />}
    </div>
  );
}

registerPanel({ id: "private", version: 1, title: "My private material", kind: "side", component: PrivatePanel, position: "right" });
registerNav({ id: "private", version: 1, label: "My private material", order: 58, panel: "private" });
