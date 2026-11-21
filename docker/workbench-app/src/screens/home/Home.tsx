// Screen 1, Home (rwr-home): the ask box, then what you were doing and what is new. Every card is drawn only
// from the signed-in subject's own documents, sessions, episodes and ideas and the shared library, read through
// lib/api.ts; the title of each card opens its screen. Nothing here is stored in the browser.
import { useRef, useState, type ReactNode } from "react";
import { Link } from "../../shell/Link";
import {
  ago, readClaimsWaiting, readDocuments, readIdeas, readNewInLibrary, readPodcasts, readSessions, runSearch, SESSIONS_LIMIT, SHOW, useCard,
  type CardState, type SearchHit,
} from "./home-data";

type Empty = { text: string; to: string; action: string } | null;

function Card({ id, title, to, more, state, retry, empty, children }: {
  id: string; title: string; to: string; more?: ReactNode; state: CardState<unknown>; retry: () => void; empty?: Empty; children?: ReactNode;
}) {
  return (
    <section className="card home-card" data-testid={"card-" + id} aria-labelledby={"h-" + id}>
      <div className="ch"><h2 id={"h-" + id}><Link to={to} data-testid={"title-" + id}>{title}</Link></h2>{more && <span className="more">{more}</span>}</div>
      {state.state === "loading" && <p className="meta" role="status" data-testid={"loading-" + id}>Loading...</p>}
      {state.state === "failed" && (
        <p className="meta" data-testid={"failed-" + id}>Could not load this card. <button type="button" onClick={retry}>Try again</button></p>
      )}
      {state.state === "ok" && empty && (
        <p className="empty" data-testid={"empty-" + id}>{empty.text} <Link to={empty.to}>{empty.action}</Link></p>
      )}
      {state.state === "ok" && !empty && children}
    </section>
  );
}

const Row = ({ to, title, meta, pill, kind = "", id }: { to: string; title: string; meta?: string; pill?: string; kind?: string; id: string }) => (
  <Link to={to} className="row" data-testid={"row-" + id}>
    <span className="row-main"><span className="row-title">{title || "(untitled)"}</span>{meta && <span className="meta">{meta}</span>}</span>
    {pill && <span className={"pill " + kind}>{pill}</span>}
  </Link>
);

const pillOf = (status: string, waiting: string): [string, string] =>
  status === "running" ? (waiting.startsWith("the model") ? ["waiting", "wait"] : ["running", "run"])
  : status === "queued" ? ["queued", "wait"]
  : status === "done" ? ["finished", "done"]
  : status === "cancelled" ? ["cancelled", "done"] : ["failed", "wait"];

function AskBox() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const [asked, setAsked] = useState("");
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const t = q.trim();
    if (t.length < 2 || busy) return;
    setBusy(true); setErr(false); setAsked(t);
    runSearch(t).then((h) => setHits(h), () => { setHits(null); setErr(true); }).finally(() => setBusy(false));
  };
  return (
    <section className="card ask-card" aria-labelledby="h-ask" data-testid="ask">
      <h1 id="h-ask">What do you want to know?</h1>
      <form className="ask" onSubmit={go} role="search">
        <label htmlFor="ask" className="meta">Search the library, or start a new research run. No document needed.</label>
        <input id="ask" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Which LGA2066 CPUs are worth it over a 7820X?" autoComplete="off" data-testid="ask-input" />
        <div className="ask-row">
          <span className="pill">Looks in: the shared library</span>
          <span className="meta">Your own documents are not searched here yet.</span>
          <span className="ask-actions">
            <button type="submit" className="btn" disabled={busy || q.trim().length < 2} data-testid="ask-go">Ask</button>
            <Link to="/research/start" className="btn pri">Start research</Link>
          </span>
        </div>
      </form>
      <div role="status" aria-live="polite" data-testid="ask-results">
        {busy && <p className="meta">Searching...</p>}
        {err && <p className="meta" data-testid="ask-failed">The search did not answer. Try again.</p>}
        {!busy && !err && hits && hits.length === 0 && <p className="empty" data-testid="ask-none">Nothing in the library matches "{asked}".</p>}
        {!busy && !err && hits && hits.length > 0 && (
          <ul className="hits" aria-label={"Results for " + asked}>
            {hits.map((h) => (
              <li key={h.kind + h.id}>
                <Link to="/library" className="row" data-testid="hit">
                  <span className="row-main"><span className="row-title">{h.title || "(untitled)"}</span>{h.snippet && <span className="meta">{h.snippet}</span>}</span>
                  <span className="pill">{h.kind}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// Home is drawn for ONE known subject. The cards live under a key made of the LAST KNOWN subject, so when the shell
// shows a DIFFERENT person (its periodic whoami read) every card, every read in flight and the ask box are dropped
// and read again for the new person; a failed poll (no subject this time) keeps the current Home, and nothing is
// drawn or read until a subject has been known at least once.
export function Home({ subject, loaded, onRetry = () => window.location.reload() }: { subject: string | null; loaded: boolean; onRetry?: () => void }) {
  const last = useRef<string | null>(null);
  if (subject) last.current = subject;
  const known = subject ?? last.current;
  if (!known) {
    return (
      <div className="screen home" data-testid="home">
        <h1 className="sr-only">Home</h1>
        {loaded
          ? <p className="meta" data-testid="home-failed">Could not tell who you are, so nothing is shown. <button type="button" onClick={onRetry}>Try again</button></p>
          : <p className="meta" role="status" data-testid="home-waiting">Checking who you are...</p>}
      </div>
    );
  }
  return <HomeCards key={known} />;
}

function HomeCards() {
  const [docs, rDocs] = useCard(readDocuments);
  const [ses, rSes] = useCard(readSessions);
  const [pod, rPod] = useCard(readPodcasts);
  const [ide, rIde] = useCard(readIdeas);
  const [neu, rNeu] = useCard(readNewInLibrary);
  const [cla, rCla] = useCard(readClaimsWaiting);
  const ok = <T,>(s: CardState<T>) => (s.state === "ok" ? s.data : null);
  const d = ok(docs), s = ok(ses), p = ok(pod), i = ok(ide), n = ok(neu), c = ok(cla);

  return (
    <div className="screen home" data-testid="home">
      <AskBox />
      <div className="grid3">
        <Card id="docs" title="Continue writing" to="/documents" more={<Link to="/documents">All documents</Link>} state={docs} retry={rDocs}
          empty={d && d.length === 0 ? { text: "You have no documents yet.", to: "/documents", action: "New document" } : null}>
          {d?.slice(0, SHOW).map((x) => (
            <Row key={x.path} id="doc" to={x.href} title={x.title}
              meta={["edited " + ago(x.updated), x.refs ? x.refs + (x.refs === 1 ? " reference" : " references") : ""].filter(Boolean).join(" · ")} />
          ))}
          <Link to="/documents" className="btn start">+ New document</Link>
        </Card>
        <Card id="research" title="Research" to="/research" more={<Link to="/research">See the tree</Link>} state={ses} retry={rSes}
          empty={s && s.rows.length === 0 && !s.capped ? { text: "No research running or finished lately.", to: "/research/start", action: "Start research" } : null}>
          {s && s.capped && s.rows.length === 0 && <p className="empty" data-testid="capped-research">None of the newest {SESSIONS_LIMIT} sessions is yours. <Link to="/research">Open Research</Link></p>}
          {s?.rows.slice(0, SHOW).map((x) => {
            const [label, kind] = pillOf(x.status, x.waiting);
            const meta = x.status === "done" ? "report ready · " + ago(x.at)
              : (x.waitKind === "branches" ? [x.waiting] : [x.branches ? x.branches + (x.branches === 1 ? " branch" : " branches") : "", x.waiting]).filter(Boolean).join(" · ");
            return <Row key={x.id} id="session" to="/research" title={x.query} meta={meta} pill={label} kind={kind} />;
          })}
        </Card>
        <Card id="podcasts" title="Podcasts" to="/podcasts" more={<Link to="/podcasts">+ New episode</Link>} state={pod} retry={rPod}
          empty={p && p.length === 0 ? { text: "No episodes yet.", to: "/podcasts", action: "New episode" } : null}>
          {p?.slice(0, SHOW).map((x) => (
            <Row key={x.id} id={x.kind} to="/podcasts" title={x.title} meta={[x.detail, ago(x.at)].filter(Boolean).join(" · ")} pill={x.label} kind={x.label === "ready" ? "done" : "wait"} />
          ))}
        </Card>
      </div>
      <div className="grid2">
        <Card id="ideas" title="Ideas" to="/ideas" more={<Link to="/ideas">All ideas</Link>} state={ide} retry={rIde}
          empty={i && i.length === 0 ? { text: "No ideas captured yet.", to: "/ideas", action: "Capture an idea" } : null}>
          {i?.slice(0, SHOW).map((x) => (
            <Row key={x.id} id="idea" to="/ideas" title={x.title} meta={"updated " + ago(x.at)} pill={x.status} />
          ))}
        </Card>
        <section className="card home-card" data-testid="card-library" aria-labelledby="h-library">
          <div className="ch"><h2 id="h-library"><Link to="/library" data-testid="title-library">New in the library this week</Link></h2></div>
          {neu.state === "loading" && <p className="meta" role="status">Loading...</p>}
          {neu.state === "failed" && <p className="meta" data-testid="failed-library">Could not load this card. <button type="button" onClick={rNeu}>Try again</button></p>}
          {n && n.sourcesTotal === 0 && n.claimsTotal === 0 && <p className="empty" data-testid="empty-library">Nothing new in the library this week. <Link to="/library">Open the library</Link></p>}
          {n && (n.sourcesTotal > 0 || n.claimsTotal > 0) && (
            <div className="row static" data-testid="new-counts">
              <span className="row-main">
                <span className="row-title">{n.sourcesTotal} new {n.sourcesTotal === 1 ? "source" : "sources"}, {n.claimsTotal} new {n.claimsTotal === 1 ? "claim" : "claims"}</span>
                {n.sources.slice(0, 3).map((x) => <span key={x.id} className="meta">{x.title || "(untitled)"}</span>)}
                <span className="meta">open them in the Library to check quality</span>
              </span>
              <Link to="/library" className="more">Review</Link>
            </div>
          )}
          <div className="ch sub"><h3><Link to="/library" data-testid="title-claims">Claims waiting for a second source</Link></h3></div>
          {cla.state === "loading" && <p className="meta" role="status">Loading...</p>}
          {cla.state === "failed" && <p className="meta" data-testid="failed-claims">Could not load this. <button type="button" onClick={rCla}>Try again</button></p>}
          {c && c.total === 0 && <p className="empty" data-testid="empty-claims">No claim waits for a second source. <Link to="/library">Open the library</Link></p>}
          {c && c.total > 0 && (
            <div className="row static" data-testid="claims-waiting">
              <span className="row-main">
                <span className="row-title">{c.total} {c.total === 1 ? "claim" : "claims"} backed by one source only</span>
                {c.samples.map((x) => <span key={x.id} className="meta">{x.text}</span>)}
              </span>
              <Link to="/library" className="more">Review</Link>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
