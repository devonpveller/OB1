// Screen 15, Removals and trail (rwr-removals). Two tabs.
//   Removed: everything taken out and not yet gone for good, with how to get it back: sources by stage (hidden,
//   cut loose; erased with their marker), connections cut, trashed and archived documents, archived ideas.
//   Trail: what happened, newest first, with the person as "You" or "Someone else". It is read only: there is no
//   edit and no delete anywhere on it.
// Everything private (documents, ideas, the document trail, your own action log) comes from reads the server
// scopes to the signed-in person; nothing here names a person, and nothing is kept in the browser.
import { useMemo, useState, type ReactNode } from "react";
import type { ScreenProps } from "../../routes";
import { TypedConfirm } from "../../shell/TypedConfirm";
import { useToast } from "../../shell/Toast";
import { DELETE_DOCUMENT, DELETE_WORD, ERASE_SOURCE, ERASE_WORD, LIFT_MARKER, type LostStays } from "./lost-stays";
import {
  dependsOn, deleteForever, eraseSource, isMine, liftMarker, tombstoneOf, plainFailure, readDocs, readDocTrail, readIdeas, readMyActions, readSources,
  readTombstone, readTrail, reopenIdea, restoreDocument, showSourceAgain, unarchiveDocument, useRead, when,
  type DocItem, type IdeaItem, type MyAction, type Read, type SourceRow,
} from "./removals-data";

type Tab = "removed" | "trail";

// A small set of radio buttons (the shared ItemPicker is a library search; a few fixed choices are radios, never a <select>).
function Choice({ legend, name, value, options, onChange, testid }: {
  legend: string; name: string; value: string; options: [string, string][]; onChange: (v: string) => void; testid: string;
}) {
  return (
    <fieldset className="rm-choice" data-testid={testid}>
      <legend>{legend}</legend>
      <div className="rm-choice-opts">
        {options.map(([v, l]) => (
          <label key={v} className="rm-opt">
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} data-testid={testid + "-" + v} />
            <span>{l}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// Only one destructive confirmation is open at a time (as on the Documents screen). `open` is the key of the open one;
// every other destructive button is off while it is open.
type Ask = { open: string | null; set: (k: string | null) => void };

// What one action did, and how the row reports a refusal.
function useDo(refresh: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async (what: string, call: () => Promise<unknown>, done: string) => {
    if (busy) return false;
    setBusy(true); setErr("");
    try { await call(); toast({ message: done }); refresh(); return true; }
    catch (e) { setErr(plainFailure(e, what)); return false; }
    finally { setBusy(false); }
  };
  return { busy, err, run };
}

function Section({ id, title, count, read, empty, children, note }: {
  id: string; title: string; count?: number; read: Read<unknown> & { retry: () => void }; empty: string; children: ReactNode; note?: string;
}) {
  return (
    <section className="card" data-testid={"sec-" + id} aria-labelledby={"h-" + id}>
      <div className="ch"><h2 id={"h-" + id}>{title}</h2>{read.state === "ok" && count !== undefined && <span className="count" data-testid={"count-" + id}>{count}</span>}</div>
      {note && <p className="meta">{note}</p>}
      {read.state === "loading" && <p className="meta" role="status">Loading...</p>}
      {read.state === "failed" && <p className="meta" data-testid={"failed-" + id}>Could not load this list. <button type="button" onClick={read.retry}>Try again</button></p>}
      {read.state === "ok" && (count === 0 ? <p className="empty" data-testid={"empty-" + id}>{empty}</p> : <ul className="rm-list">{children}</ul>)}
    </section>
  );
}

function LostStaysBox({ ls }: { ls: LostStays }) {
  return (
    <div className="lost-stays" data-testid="lost-stays">
      <div><h3>What is lost</h3><ul>{ls.lost.map((t) => <li key={t}>{t}</li>)}</ul></div>
      <div><h3>What stays</h3><ul>{ls.stays.map((t) => <li key={t}>{t}</li>)}</ul></div>
    </div>
  );
}

const REASONS: [string, string][] = [
  ["deliberate", "On purpose: I do not want it"],
  ["credibility", "It was not credible enough"],
  ["debunked", "It was shown to be wrong"],
];

function SourceItem({ s, by, refresh, ask }: { s: SourceRow; by: string; refresh: () => void; ask: Ask }) {
  const d = useDo(refresh);
  const key = "src:" + s.id;
  const erasing = ask.open === key, off = ask.open !== null && !erasing;
  const setErasing = (on: boolean) => ask.set(on ? key : null);
  const [reason, setReason] = useState("deliberate");
  const dep = dependsOn(s.counts);
  return (
    <li className="rm-row" data-testid="row-source" data-stage={s.stage}>
      <div className="rm-head">
        <span className="row-title">{s.title || "(untitled source)"}</span>
        <span className={"pill " + (s.stage === "hidden" ? "wait" : "done")}>{s.stage === "hidden" ? "Hidden" : "Cut loose"}</span>
      </div>
      {s.url && <span className="meta">{s.url}</span>}
      <dl className="rm-facts">
        <dt>By</dt><dd data-testid="by">{by}</dd>
        <dt>Why</dt><dd data-testid="why">{s.reason || "No reason recorded"}</dd>
        <dt>When</dt><dd>{when(s.at)}</dd>
        <dt>Depended on it</dt>
        <dd data-testid="depended">
          {dep.shared.length === 0 && !dep.private ? "Nothing depends on it." : (
            <>{dep.shared.join(", ")}{dep.shared.length > 0 && dep.private ? "; " : ""}{dep.private ? "something in private work still holds it" : ""}.</>
          )}
        </dd>
      </dl>
      {!s.eraseAllowed && (
        <p className="meta" data-testid="erase-blocked">
          Erasing is not possible yet{s.stage === "hidden" ? ": it is only hidden and still connected" : ""}
          {s.blocked ? ". What depends on it (above) has to be cleared first." : "."}
        </p>
      )}
      {erasing ? (
        <div className="rm-erase" data-testid="erase-panel">
          <LostStaysBox ls={ERASE_SOURCE} />
          <Choice legend="Why are you erasing it?" name={"erase-reason-" + s.id} value={reason} onChange={setReason} options={REASONS} testid="erase-reason" />
          <TypedConfirm word={ERASE_WORD} prompt={`This erases "${s.title || "this source"}" for good.`} confirmLabel="Erase for good"
            onCancel={() => setErasing(false)}
            onConfirm={() => { void d.run("erase", () => eraseSource(s.id, reason), "Erased. Its marker and trail line stay.").then((ok) => { if (ok) setErasing(false); }); }} />
        </div>
      ) : (
        <div className="rm-actions">
          <button type="button" data-testid="show-again" disabled={d.busy} onClick={() => void d.run("restore", () => showSourceAgain(s.id), "Shown again.")}>Show it again</button>
          {s.eraseAllowed && <button type="button" className="danger" data-testid="erase" disabled={d.busy || off} onClick={() => setErasing(true)}>Erase for good</button>}
        </div>
      )}
      {d.err && <p className="rm-err" role="alert" data-testid="row-error">{d.err}</p>}
    </li>
  );
}

type Erased = { tombstoneId: string; title: string; url: string; reason: string; at: string };

function ErasedItem({ e, refresh, ask }: { e: Erased; refresh: () => void; ask: Ask }) {
  const facts = useRead(() => readTombstone(e.tombstoneId), 0);
  const d = useDo(refresh);
  const key = "tomb:" + e.tombstoneId;
  const lifting = ask.open === key, off = ask.open !== null && !lifting;
  const setLifting = (on: boolean) => ask.set(on ? key : null);
  const mayLift = facts.state === "ok" && facts.data.mayLift;
  const by = facts.state === "ok" ? (facts.data.byYou ? "You" : "Someone else") : "Not known";
  return (
    <li className="rm-row" data-testid="row-erased">
      <div className="rm-head"><span className="row-title">{e.title || "(untitled source)"}</span><span className="pill done">Erased</span></div>
      {e.url && <span className="meta">{e.url}</span>}
      <dl className="rm-facts">
        <dt>By</dt><dd data-testid="by">{by}</dd>
        <dt>Why</dt><dd data-testid="why">{e.reason || "No reason recorded"}</dd>
        <dt>When</dt><dd>{when(e.at)}</dd>
        <dt>Getting it back</dt><dd>The text is gone. Lifting the marker only lets the address be added again.</dd>
      </dl>
      {facts.state === "ok" && !mayLift && <p className="meta" data-testid="lift-not-yours">Only the person who erased it, or an administrator, can lift its marker.</p>}
      {mayLift && (lifting ? (
        <div className="rm-erase" data-testid="lift-panel">
          <LostStaysBox ls={LIFT_MARKER} />
          <div className="rm-actions">
            <button type="button" onClick={() => setLifting(false)}>Cancel</button>
            <button type="button" data-testid="lift-ok" disabled={d.busy} onClick={() => void d.run("lift", () => liftMarker(e.tombstoneId), "Marker lifted.").then((ok) => { if (ok) setLifting(false); })}>Lift the marker</button>
          </div>
        </div>
      ) : (
        <div className="rm-actions"><button type="button" data-testid="lift" disabled={off} onClick={() => setLifting(true)}>Lift the marker</button></div>
      ))}
      {d.err && <p className="rm-err" role="alert" data-testid="row-error">{d.err}</p>}
    </li>
  );
}

function DocumentItem({ doc, refresh, ask }: { doc: DocItem; refresh: () => void; ask: Ask }) {
  const d = useDo(refresh);
  const key = "doc:" + doc.path;
  const deleting = ask.open === key, off = ask.open !== null && !deleting;
  const setDeleting = (on: boolean) => ask.set(on ? key : null);
  const trashed = doc.where === "trashed";
  return (
    <li className="rm-row" data-testid={trashed ? "row-trashed" : "row-archived"}>
      <div className="rm-head"><span className="row-title">{doc.title || "(untitled document)"}</span><span className="pill done">{trashed ? "In the trash" : "Archived"}</span></div>
      <span className="meta">Last changed {when(doc.updated)}</span>
      {deleting ? (
        <div className="rm-erase" data-testid="delete-panel">
          <LostStaysBox ls={DELETE_DOCUMENT} />
          <TypedConfirm word={DELETE_WORD} prompt={`This deletes "${doc.title || "this document"}" for good.`} confirmLabel="Delete forever"
            onCancel={() => setDeleting(false)}
            onConfirm={() => { void d.run("delete", () => deleteForever(doc.path), "Deleted forever.").then((ok) => { if (ok) setDeleting(false); }); }} />
        </div>
      ) : (
        <div className="rm-actions">
          <button type="button" data-testid="show-again" disabled={d.busy}
            onClick={() => void d.run("restore", () => (trashed ? restoreDocument(doc.path) : unarchiveDocument(doc.path)), "Shown again in your documents.")}>Show it again</button>
          {trashed && <button type="button" className="danger" data-testid="delete-forever" disabled={d.busy || off} onClick={() => setDeleting(true)}>Delete forever</button>}
        </div>
      )}
      {d.err && <p className="rm-err" role="alert" data-testid="row-error">{d.err}</p>}
    </li>
  );
}

function IdeaItem({ idea, refresh }: { idea: IdeaItem; refresh: () => void }) {
  const d = useDo(refresh);
  return (
    <li className="rm-row" data-testid="row-idea">
      <div className="rm-head"><span className="row-title">{idea.title || "(untitled idea)"}</span><span className="pill done">Archived</span></div>
      <span className="meta">Last changed {when(idea.updated)}</span>
      <div className="rm-actions">
        <button type="button" data-testid="show-again" disabled={d.busy} onClick={() => void d.run("reopen", () => reopenIdea(idea.id), "Idea shown again.")}>Show it again</button>
      </div>
      {d.err && <p className="rm-err" role="alert" data-testid="row-error">{d.err}</p>}
    </li>
  );
}

const KIND_LABEL: Record<string, string> = {
  claim_edge: "a claim link", chunk: "a text piece", citing_page: "a citing page", entity_grounding: "a named-thing link", found_via_lead: "a lead",
  document_link: "a document link", reference_record: "a reference", report_session: "a report link", report_citation: "a report citation",
};

// ---- the Removed tab
function RemovedTab({ tick, refresh }: { tick: number; refresh: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const ask: Ask = { open, set: setOpen };
  const sources = useRead(readSources, tick);
  const trail = useRead(readTrail, tick);
  const mine = useRead(readMyActions, tick);
  const docs = useRead(readDocs, tick);
  const ideas = useRead(readIdeas, tick);

  const titles = useMemo(() => {
    const m = new Map<string, string>();
    if (trail.state === "ok") for (const e of trail.data) { const t = e.context.title; if (typeof t === "string" && t) m.set(e.sourceId, t); }
    if (sources.state === "ok") for (const s of sources.data) if (s.title) m.set(s.id, s.title);
    return m;
  }, [trail, sources]);

  const mineList: MyAction[] | null = mine.state === "ok" ? mine.data : null;
  const byOf = (s: SourceRow): string => {
    if (trail.state !== "ok" || !mineList) return "Not known";
    const e = trail.data.find((t) => t.kind === "suppressed" && t.sourceId === s.id && t.state !== "redaction");
    return e ? (isMine(e, mineList) ? "You" : "Someone else") : "Not known";
  };

  const erased = useMemo<Erased[]>(() => {
    if (trail.state !== "ok") return [];
    const lifted = new Set(trail.data.map((e) => (e.kind === "lifted" ? tombstoneOf(e) : null)).filter((x): x is string => x !== null));
    return trail.data.filter((e) => e.kind === "erased" && e.tombstoneId && !lifted.has(e.tombstoneId))
      .map((e) => ({ tombstoneId: e.tombstoneId!, title: String(e.context.title ?? ""), url: String(e.context.url ?? ""), reason: e.reason, at: e.at }));
  }, [trail]);

  const cut = useMemo(() => {
    if (trail.state !== "ok") return [] as { key: string; title: string; kind: string; n: number; at: string; mine: boolean }[];
    const g = new Map<string, { key: string; title: string; kind: string; n: number; at: string; mine: boolean }>();
    for (const e of trail.data.filter((t) => t.kind === "severed")) {
      const kind = String(e.context.kind ?? "");
      const key = e.sourceId + "|" + kind + "|" + e.at.slice(0, 16);
      const cur = g.get(key);
      const m = mineList ? isMine(e, mineList) : false;
      if (cur) { cur.n += 1; cur.mine = cur.mine && m; } else g.set(key, { key, title: titles.get(e.sourceId) ?? "a source", kind, n: 1, at: e.at, mine: m });
    }
    return [...g.values()];
  }, [trail, titles, mineList]);

  const trashed = docs.state === "ok" ? docs.data.filter((d) => d.where === "trashed") : [];
  const archived = docs.state === "ok" ? docs.data.filter((d) => d.where === "archived") : [];
  const archIdeas = ideas.state === "ok" ? ideas.data.filter((i) => i.status === "archived") : [];
  const srcs = sources.state === "ok" ? sources.data : [];
  // the erased and cut lists come from the trail read
  const trailRead = trail;

  return (
    <div className="rm-tab" data-testid="removed-tab">
      <Section id="sources" title="Sources taken out" count={srcs.length} read={sources} empty="No source is hidden or cut loose."
        note="Shared library sources. Show it again puts a source back; Erase for good is offered only when nothing depends on it.">
        {srcs.map((s) => <SourceItem key={s.id} s={s} by={byOf(s)} refresh={refresh} ask={ask} />)}
      </Section>
      <Section id="erased" title="Erased sources (marker kept)" count={erased.length} read={trailRead} empty="No erased source has a marker waiting."
        note="An erased source leaves a marker so its address is not added again by accident.">
        {erased.map((e) => <ErasedItem key={e.tombstoneId} e={e} refresh={refresh} ask={ask} />)}
      </Section>
      <Section id="cut" title="Connections cut" count={cut.length} read={trailRead} empty="No connection has been cut."
        note="A cut connection stays cut: showing a source again does not rebuild its links.">
        {cut.map((c) => (
          <li className="rm-row" key={c.key} data-testid="row-cut">
            <div className="rm-head"><span className="row-title">{c.n > 1 ? `${c.n} connections` : "1 connection"} ({KIND_LABEL[c.kind] ?? "a link"}) cut from {c.title}</span></div>
            <span className="meta">{when(c.at)} by {mineList ? (c.mine ? "You" : "Someone else") : "Not known"}</span>
          </li>
        ))}
      </Section>
      <Section id="trashed" title="Documents in the trash" count={trashed.length} read={docs} empty="Your trash is empty."
        note="Showing a document again returns it to its folder, and the Trail tab records it.">
        {trashed.map((d) => <DocumentItem key={d.path} doc={d} refresh={refresh} ask={ask} />)}
      </Section>
      <Section id="archived" title="Archived documents" count={archived.length} read={docs} empty="You have no archived documents.">
        {archived.map((d) => <DocumentItem key={d.path} doc={d} refresh={refresh} ask={ask} />)}
      </Section>
      <Section id="ideas" title="Archived ideas" count={archIdeas.length} read={ideas} empty="You have no archived ideas." note="Showing an idea again is not recorded in the Trail yet.">
        {archIdeas.map((i) => <IdeaItem key={i.id} idea={i} refresh={refresh} />)}
      </Section>
    </div>
  );
}

// ---- the Trail tab (read only)
type Item = { key: string; at: string; area: "Sources" | "Documents"; what: string; kind: string; subject: string; who: string; mine: boolean; note?: string };

const SOURCE_WHAT: Record<string, string> = {
  suppressed: "Hidden", unlinked: "Cut loose", severed: "Connection cut", erased: "Erased for good", lifted: "Marker lifted",
  restored: "Shown again", reopen_attempt: "Someone tried to add it again", readmitted: "Added again",
};
// documents/trail.ts TrailKind: the removal lines and, since rwr-trail-grants-exact, the put-back lines
// (documents/repo.ts restoreDocument writes "restored"; moveToLocked/unarchive writes "unarchived").
const DOC_WHAT: Record<string, string> = {
  delete_forever: "Deleted forever", empty_trash: "Trash emptied", nightly_expired: "Removed after 30 days in the trash",
  restored: "Shown again from the trash or archive", unarchived: "Taken out of the archive",
};
// Readable words for a line that only your own action log knows (cleanup action kinds).
const ACTION_WORDS: Record<string, string> = {
  suppress: "You hid a source", retract: "You hid a source", sever: "You cut a connection", restore: "You showed a source again",
  lift: "You lifted a marker", erase: "You erased a source", unlink: "You cut a source loose",
};
const fileName = (p: string) => (p.split("/").pop() ?? p).replace(/\.md$/i, "");
const NIGHTLY = "system:nightly";
// real restored detail: { from, to, reason, door } (repositories/sources.ts:340-342); `from` is the stage it came back from
const restoredWhat = (from: unknown) => from === "unlinked" ? "Shown again (it had been cut loose)" : from === "suppressed" ? "Shown again (it had been hidden)" : "Shown again";

function TrailTab({ tick, subject }: { tick: number; subject: string | null }) {
  const trail = useRead(readTrail, tick);
  const mine = useRead(readMyActions, tick);
  const docTrail = useRead(readDocTrail, tick);
  const [show, setShow] = useState("all");
  const [what, setWhat] = useState("all");
  const [who, setWho] = useState("all");

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const ma = mine.state === "ok" ? mine.data : null;
    const matched = new Set<string>();
    if (trail.state === "ok") {
      const titles = new Map<string, string>();
      for (const e of trail.data) { const t = e.context.title; if (typeof t === "string" && t) titles.set(e.sourceId, t); }
      trail.data.forEach((e, i) => {
        const m = ma ? isMine(e, ma) : false;
        const tid = tombstoneOf(e);
        if (ma && m) for (const a of ma) if (a.sourceId === e.sourceId || (tid && a.tombstoneId === tid)) matched.add(a.id);
        out.push({
          key: "s" + i, at: e.at, area: "Sources", kind: e.kind, what: e.kind === "restored" ? restoredWhat(e.context.from) : SOURCE_WHAT[e.kind] ?? "Changed", mine: m,
          // a "restored" line carries no title (the source is active again), so it reads "a source": a title is never made up
          subject: titles.get(e.sourceId) ?? "a source", who: !ma ? "Not known" : m ? "You" : "Someone else",
          note: e.kind === "suppressed" || e.kind === "erased" ? (e.reason || undefined)
            : e.kind === "restored" && typeof e.context.reason === "string" && e.context.reason ? "It had been taken out because: " + e.context.reason : undefined,
        });
      });
    }
    if (docTrail.state === "ok") {
      docTrail.data.forEach((l, i) => {
        const nightly = l.actor === NIGHTLY, you = subject !== null && l.actor === subject;
        out.push({
          key: "d" + i, at: l.at, area: "Documents", kind: l.kind, what: DOC_WHAT[l.kind] ?? "Changed", mine: you, subject: fileName(l.path),
          who: nightly ? "The nightly clean-up" : you ? "You" : "An administrator",
        });
      });
    }
    // an action of yours that left no shared trail line is still shown (from your own action log), so none goes missing
    if (ma && trail.state === "ok") {
      for (const a of ma) {
        if (matched.has(a.id) || a.kind === "process_all") continue;
        out.push({ key: "a" + a.id, at: a.at, area: "Sources", kind: a.kind, what: ACTION_WORDS[a.kind] ?? "An action of yours", mine: true, subject: "a source", who: "You" });
      }
    }
    return out.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  }, [trail, mine, docTrail, subject]);

  const shown = items.filter((i) => (show === "all" || i.area === show) && (what === "all" || i.kind === what) && (who === "all" || i.mine));
  const failed = [trail, mine, docTrail].filter((r) => r.state === "failed").length > 0;
  const loading = [trail, mine, docTrail].some((r) => r.state === "loading");
  const kinds = ["suppressed", "unlinked", "severed", "erased", "lifted", "restored", "unarchived", "delete_forever", "empty_trash", "nightly_expired"];
  const labelOf = (k: string) => SOURCE_WHAT[k] ?? DOC_WHAT[k] ?? k;

  return (
    <div className="rm-tab" data-testid="trail-tab">
      <section className="card" aria-labelledby="h-trail">
        <h2 id="h-trail">What happened</h2>
        <p className="meta">Nothing on this screen can change or delete a line. A Hidden line is read from the source's state now, so it goes when the source is shown again; the Shown again line stays. Your own documents appear here only to you.</p>
        <div className="rm-filters" role="group" aria-label="Filter the trail">
          <Choice legend="Show" name="f-show" value={show} onChange={setShow} testid="f-show"
            options={[["all", "Sources and documents"], ["Sources", "Sources"], ["Documents", "Documents"]]} />
          <Choice legend="What" name="f-what" value={what} onChange={setWhat} testid="f-what"
            options={[["all", "Everything"], ...kinds.map((k): [string, string] => [k, labelOf(k)])]} />
          <Choice legend="Who" name="f-who" value={who} onChange={setWho} testid="f-who" options={[["all", "Everyone"], ["me", "Only me"]]} />
        </div>
        {loading && <p className="meta" role="status">Loading...</p>}
        {failed && <p className="meta" data-testid="trail-failed">Part of the trail could not be loaded, so it may be incomplete.</p>}
        {!loading && shown.length === 0 && <p className="empty" data-testid="trail-empty">Nothing matches.</p>}
        {shown.length > 0 && (
          <ol className="rm-trail" data-testid="trail-list">
            {shown.map((i) => (
              <li key={i.key} data-testid="trail-line" data-kind={i.kind} data-who={i.who}>
                <span className="meta">{when(i.at)}</span>
                <span className="row-title">{i.what}: {i.subject}</span>
                <span className="pill">{i.who}</span>
                {i.note && <span className="meta">Reason: {i.note}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

export function Removals({ subject, ready }: { subject: string | null; ready: boolean }) {
  const [tab, setTab] = useState<Tab>("removed");
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  const tabs: [Tab, string][] = [["removed", "Removed"], ["trail", "Trail"]];
  return (
    <section className="screen removals" data-testid="removals">
      <h1>Removals and trail</h1>
      <p className="lead">Everything you or the library took out, how to get it back, and a record of what happened.</p>
      <div role="tablist" aria-label="Removals and trail" className="rm-tabs"
        onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const n = tab === "removed" ? "trail" : "removed"; setTab(n); document.getElementById("tab-" + n)?.focus(); e.preventDefault(); } }}>
        {tabs.map(([t, label]) => (
          <button key={t} type="button" role="tab" id={"tab-" + t} aria-selected={tab === t} tabIndex={tab === t ? 0 : -1} aria-controls={"panel-" + t} data-testid={"tab-" + t}
            onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>
      <div role="tabpanel" id={"panel-" + tab} aria-labelledby={"tab-" + tab}>
        {!ready ? <p className="meta" role="status">Loading...</p> : tab === "removed" ? <RemovedTab tick={tick} refresh={refresh} /> : <TrailTab tick={tick} subject={subject} />}
      </div>
    </section>
  );
}

// The route's screen (routes.ts `screen`): keyed by the signed-in person, so a change of person starts from nothing.
export function RemovalsScreen({ subject, whoAnswered }: ScreenProps) {
  return <Removals key={subject ?? ""} subject={subject} ready={whoAnswered} />;
}
