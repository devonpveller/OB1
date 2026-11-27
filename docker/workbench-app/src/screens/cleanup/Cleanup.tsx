// Screen 16, Cleanup (rwr-cleanup). Four tabs: Suggestions (empty until the scan item lands), Flagged by you, Ready to erase,
// Worth reopening. Each item shows why it is here, what it affects, a preview and the reason kept. Each tab can be worked
// through one at a time ("Review one at a time", ending in a summary of what was decided) or, on Ready to erase, all at once
// ("Apply to all": ONE reason for the whole batch, and the screen says so). "Not again for this" hides a reopen candidate (or,
// later, a suggestion) for this person only, and it stays hidden.
//
// Rules kept here (each has a test): a typed word is keyed to its target (it never carries to another one); only one destructive
// confirmation is open at a time and every other destructive button is off while it is open; a request is sent only while the
// person who opened it is still signed in; one action per target at a time (a double click, or a second place offering the same
// action, sends one request); a change of person drops every dialog, draft, review and toast; nothing private goes into the page
// title or the browser's storage; reasons are the server's registry's words; links back are opaque (flagBackLink).
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ScreenProps } from "../../routes";
import { Link } from "../../shell/Link";
import { TypedConfirm } from "../../shell/TypedConfirm";
import { useToast } from "../../shell/Toast";
import { isSamePerson } from "../document-editor/editor-data";
import { ERASE_SOURCE, ERASE_WORD, LIFT_MARKER, type LostStays } from "../removals/lost-stays";
import { useRead, when, type Read } from "../removals/removals-data";
import {
  applyAll, backLink, dismiss, ERASE_REASONS, eraseReasonWords, eraseSource, itemWords, liftMarker, plainFailure, readCandidates, readDismissals,
  readFlags, readReady, readReasonWords, readSuggestions, undismiss, visibleSuggestions, withdrawFlag, reasonLabel,
  type BatchResult, type Candidate, type FlagItem, type ReadyItem, type ReasonWords,
} from "./cleanup-data";
import "./cleanup.css";

type Tab = "suggestions" | "flagged" | "ready" | "reopen";
const TABS: [Tab, string][] = [["suggestions", "Suggestions"], ["flagged", "Flagged by you"], ["ready", "Ready to erase"], ["reopen", "Worth reopening"]];

// One confirmation at a time: `open` is the key of the open one; every other destructive button is off while it is open.
type Ask = { open: string | null; set: (k: string | null) => void };
// What every card needs from the screen.
type Env = { subject: string | null; ask: Ask; reasons: ReasonWords | null };
// What happened to one item: its words for the toast / the summary; `undo` takes a dismissal back.
// `toast` is a fixed sentence (no title); `text` is for the review summary on the screen.
type Done = { text: string; toast: string; undo?: () => Promise<unknown> };

// One action per target at a time, for the whole screen (a list card and a review card of the same item share it). The key
// carries the person: a request still held for the person who was signed in must never swallow the next person's action on the
// same (shared) target, and the owner of an entry is the card instance that took it, so a different card asking for the same
// target says so instead of returning silently.
const inFlight = new Map<string, object>();

function useDo(env: Env, key: string, onDone: (d: Done) => void) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const live = useRef(true);
  const me = useRef({}).current;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const run = async (what: string, call: () => Promise<unknown>, done: Done | ((r: any) => Done)) => {
    const gate = (env.subject ?? "") + "|" + key;
    const holder = inFlight.get(gate);
    if (holder) {
      // the same card asking twice (a double click) is one request, quietly; another card for the same target is told
      if (holder !== me && live.current) setErr("That is already being done from another place on this screen.");
      return false;
    }
    inFlight.set(gate, me);
    setBusy(true); setErr("");
    try {
      // the request goes only while the person who opened it is still the one signed in
      if (env.subject !== null && !(await isSamePerson(env.subject))) { if (live.current) setErr("The person signed in changed, so nothing was done."); return false; }
      const r = await call();
      if (live.current) onDone(typeof done === "function" ? done(r) : done);
      return true;
    } catch (e) {
      if (live.current) setErr(plainFailure(e, what));
      return false;
    } finally {
      inFlight.delete(gate);
      if (live.current) setBusy(false);
    }
  };
  return { busy, err, run };
}

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

function LostStaysBox({ ls }: { ls: LostStays }) {
  return (
    <div className="lost-stays" data-testid="lost-stays">
      <div><h3>What is lost</h3><ul>{ls.lost.map((t) => <li key={t}>{t}</li>)}</ul></div>
      <div><h3>What stays</h3><ul>{ls.stays.map((t) => <li key={t}>{t}</li>)}</ul></div>
    </div>
  );
}

function Facts({ rows }: { rows: [string, ReactNode, string][] }) {
  return (
    <dl className="rm-facts">
      {rows.map(([k, v, id]) => <FactRow key={id} k={k} v={v} id={id} />)}
    </dl>
  );
}
const FactRow = ({ k, v, id }: { k: string; v: ReactNode; id: string }) => (<><dt>{k}</dt><dd data-testid={"fact-" + id}>{v}</dd></>);

// ---- Ready to erase
function ReadyCard({ s, env, onDone }: { s: ReadyItem; env: Env; onDone: (d: Done) => void }) {
  const key = "src:" + s.id;
  const d = useDo(env, key, onDone);
  const erasing = env.ask.open === key, off = env.ask.open !== null && !erasing;
  const [reason, setReason] = useState("deliberate");
  const dep = s.affects;
  return (
    <div className="rm-row" data-testid="card-ready">
      <div className="rm-head"><span className="row-title" data-testid="card-title">{s.title || "(untitled source)"}</span><span className="pill done">Ready to erase</span></div>
      <Facts rows={[
        ["Why it is here", s.why || "No reason recorded", "why"],
        ["What it affects", dep.shared.length === 0 && !dep.private ? "Nothing depends on it." : `${dep.shared.join(", ")}${dep.shared.length && dep.private ? "; " : ""}${dep.private ? "something in private work still holds it" : ""}.`, "affects"],
        ["Preview", s.url ? s.url : "No address recorded", "preview"],
        ["Hidden since", when(s.at), "when"],
      ]} />
      {erasing ? (
        <div className="rm-erase" data-testid="erase-panel">
          <LostStaysBox ls={ERASE_SOURCE} />
          <Choice legend="Why are you erasing it?" name={"erase-reason-" + s.id} value={reason} onChange={setReason} options={ERASE_REASONS} testid="erase-reason" />
          <TypedConfirm key={key} word={ERASE_WORD} prompt={`This erases "${s.title || "this source"}" for good.`} confirmLabel="Erase for good"
            onCancel={() => env.ask.set(null)}
            onConfirm={() => { void d.run("erase", () => eraseSource(s.id, reason), { text: `Erased "${s.title || "a source"}" (${eraseReasonWords(reason)})`, toast: "Erased. Its marker and trail line stay." }).then((ok) => { if (ok) env.ask.set(null); }); }} />
        </div>
      ) : (
        <div className="rm-actions">
          <button type="button" className="danger" data-testid="erase" disabled={d.busy || off} onClick={() => env.ask.set(key)}>Erase for good</button>
        </div>
      )}
      {d.err && <p className="rm-err" role="alert" data-testid="card-error">{d.err}</p>}
    </div>
  );
}

// ---- Worth reopening
function CandidateCard({ c, env, onDone }: { c: Candidate; env: Env; onDone: (d: Done) => void }) {
  const key = "tomb:" + c.tombstoneId;
  const d = useDo(env, key, onDone);
  const reopening = env.ask.open === key, off = env.ask.open !== null && !reopening;
  return (
    <div className="rm-row" data-testid="card-reopen">
      <div className="rm-head"><span className="row-title" data-testid="card-title">{c.title || "(untitled source)"}</span><span className="pill wait">Worth reopening</span></div>
      <Facts rows={[
        ["Why it is here", c.evidence.length > 0 ? `New evidence points back at it (${c.evidence.length}).` : "Its address came back.", "why"],
        ["What it affects", c.disputes ? "Reopening lets the address in again and attaches the earlier debunking as criticism. The erased text stays gone." : "Reopening lets the address be added again. The erased text stays gone.", "affects"],
        ["Preview", c.url || "No address recorded", "preview"],
        ["Reason kept", `${eraseReasonWords(c.reasonType)}${c.note ? ": " + c.note : ""}`, "kept"],
      ]} />
      {c.evidence.length > 0 && (
        <ul className="meta cl-evidence" data-testid="evidence">
          {c.evidence.slice(0, 3).map((e, i) => <li key={i}>{e.note || e.reason || "Seen again"}{e.at ? " (" + when(e.at) + ")" : ""}</li>)}
        </ul>
      )}
      {reopening ? (
        <div className="rm-erase" data-testid="reopen-panel">
          <LostStaysBox ls={LIFT_MARKER} />
          <div className="rm-actions">
            <button type="button" data-testid="reopen-cancel" onClick={() => env.ask.set(null)}>Cancel</button>
            <button type="button" className="danger" data-testid="reopen-ok" disabled={d.busy}
              onClick={() => void d.run("lift", () => liftMarker(c.tombstoneId), { text: `Reopened "${c.title || "a source"}"`, toast: "Reopened. The address can be added again." }).then((ok) => { if (ok) env.ask.set(null); })}>Reopen it</button>
          </div>
        </div>
      ) : (
        <div className="rm-actions">
          {c.byYou
            ? <button type="button" className="danger" data-testid="reopen" disabled={d.busy || off} onClick={() => env.ask.set(key)}>Reopen it</button>
            : <p className="meta" data-testid="reopen-not-yours">Only the person who erased it can reopen it.</p>}
          <button type="button" data-testid="dismiss" disabled={d.busy}
            onClick={() => void d.run("dismiss", async () => (await dismiss("reopen_candidate", c.tombstoneId)),
              (id: string) => ({ text: `Will not show "${c.title || "a source"}" again`, toast: "It will not be shown to you again.", undo: () => undismiss(id) }))}>Not again for this</button>
        </div>
      )}
      {d.err && <p className="rm-err" role="alert" data-testid="card-error">{d.err}</p>}
    </div>
  );
}

// ---- Flagged by you
function FlagCard({ f, env, onDone }: { f: FlagItem; env: Env; onDone: (d: Done) => void }) {
  const d = useDo(env, "flag:" + f.id, onDone);
  const [link, setLink] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    backLink(f.from).then((l) => { if (live) setLink(l); }, () => { if (live) setLink(null); });
    return () => { live = false; };
  }, [f.from.kind, f.from.ref]);
  const why = reasonLabel(f.reason, env.reasons);
  return (
    <div className="rm-row" data-testid="card-flag">
      <div className="rm-head"><span className="row-title" data-testid="card-title">{sentenceOf(itemWords(f.itemKind))} you flagged</span><span className="pill wait" data-testid="flag-reason">{why}</span></div>
      <Facts rows={[
        ["Why it is here", `You flagged it as: ${why}.`, "why"],
        ["What it affects", "Nothing yet: a flag only puts it on your list. Only you and admins can see it.", "affects"],
        ["Your note", f.note || "No note", "note"],
        ["Flagged", when(f.at), "when"],
        ["Where", link === undefined ? "Looking..." : link === null ? "Where you flagged it is not available any more." : <Link to={link} data-testid="flag-link">Open where you flagged it</Link>, "where"],
      ]} />
      <div className="rm-actions">
        <button type="button" data-testid="withdraw" disabled={d.busy}
          onClick={() => void d.run("withdraw", () => withdrawFlag(f.id), { text: `Took back your flag (${why})`, toast: "Took back your flag." })}>Take the flag back</button>
      </div>
      {d.err && <p className="rm-err" role="alert" data-testid="card-error">{d.err}</p>}
    </div>
  );
}
const sentenceOf = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- the lists
type Page = { title: string; empty: string; note?: string };

function Section({ read, count, page, children, extra }: { read: Read<unknown> & { retry: () => void }; count: number; page: Page; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="card" aria-labelledby="h-cl" data-testid="cl-section">
      <div className="ch"><h2 id="h-cl">{page.title}</h2>{read.state === "ok" && <span className="count" data-testid="count">{count}</span>}</div>
      {page.note && <p className="meta" data-testid="tab-note">{page.note}</p>}
      {read.state === "loading" && <p className="meta" role="status">Loading...</p>}
      {read.state === "failed" && <p className="meta" data-testid="failed">Could not load this list. <button type="button" onClick={read.retry}>Try again</button></p>}
      {read.state === "ok" && (count === 0 ? <p className="empty" data-testid="empty">{page.empty}</p> : <>{extra}<ul className="rm-list">{children}</ul></>)}
    </section>
  );
}

type Decision = { text: string; ok: boolean };

// One item at a time. The queue is fixed when the review starts; each step records what was decided, and the end is a summary.
function Review<T>({ items, idOf, render, onClose, refresh, onStep }: {
  items: T[]; idOf: (x: T) => string; render: (x: T, onDone: (d: Done) => void) => ReactNode; onClose: () => void; refresh: () => void;
  onStep: () => void; // every step (decided, left for now, stopped) closes any open confirmation: the card that held it is gone
}) {
  const [queue] = useState(items);
  const [i, setI] = useState(0);
  const [log, setLog] = useState<Decision[]>([]);
  const [finished, setFinished] = useState(false);
  const total = queue.length;
  const step = (text: string, ok: boolean) => {
    onStep();
    setLog((l) => [...l, { text, ok }]);
    if (i + 1 >= total) { setFinished(true); refresh(); } else setI(i + 1);
  };
  if (finished || total === 0) {
    const done = log.filter((l) => l.ok).length;
    return (
      <div className="cl-review" data-testid="review-summary" role="region" aria-label="Summary of what you decided">
        <h2>What you decided</h2>
        <p data-testid="review-counts">You decided on {done} of {total} {total === 1 ? "item" : "items"}; {total - done} {total - done === 1 ? "was" : "were"} left as {total - done === 1 ? "it was" : "they were"}.</p>
        <ul data-testid="review-log">{log.map((l, k) => <li key={k}>{l.text}</li>)}</ul>
        <button type="button" data-testid="review-close" onClick={onClose}>Back to the list</button>
      </div>
    );
  }
  const cur = queue[i];
  return (
    <div className="cl-review" data-testid="review" role="region" aria-label="Review one at a time">
      <div className="rm-head"><h2>Review one at a time</h2><span className="meta" data-testid="review-progress">{i + 1} of {total}</span></div>
      <div key={idOf(cur)}>{render(cur, (d) => step(d.text, true))}</div>
      <div className="rm-actions">
        <button type="button" data-testid="review-skip" onClick={() => step("Left it as it was", false)}>Leave it for now</button>
        <button type="button" data-testid="review-stop" onClick={() => { onStep(); setFinished(true); }}>Stop and see the summary</button>
      </div>
    </div>
  );
}

function ReviewButton({ n, onStart, disabled }: { n: number; onStart: () => void; disabled?: boolean }) {
  return <button type="button" data-testid="review-start" disabled={disabled || n === 0} onClick={onStart}>Review one at a time</button>;
}

function useListDone(refresh: () => void) {
  const toast = useToast();
  return (d: Done) => {
    toast(d.undo ? { message: d.toast, undoLabel: "Undo", onUndo: () => { void d.undo!().then(refresh, refresh); } } : { message: d.toast });
    refresh();
  };
}

function ReadyTab({ env, tick, refresh }: { env: Env; tick: number; refresh: () => void }) {
  const read = useRead(readReady, tick);
  const [mode, setMode] = useState<"list" | "review">("list");
  const [reason, setReason] = useState("deliberate");
  const [result, setResult] = useState<{ r: BatchResult; reason: string; n: number } | null>(null);
  const onDone = useListDone(refresh);
  const items = read.state === "ok" ? read.data : [];
  const allKey = "all", asking = env.ask.open === allKey, off = env.ask.open !== null && !asking;
  const batch = useDo(env, "batch", () => {});
  const page: Page = {
    title: "Ready to erase", empty: "Nothing is waiting to be erased.",
    note: "Sources that were taken out and that nothing depends on any more. Erasing keeps a marker; it cannot be undone.",
  };
  if (mode === "review") {
    return <Review items={items} idOf={(s) => s.id} refresh={refresh} onStep={() => env.ask.set(null)} onClose={() => { env.ask.set(null); setMode("list"); }}
      render={(s, d) => <ReadyCard s={s} env={env} onDone={(x) => { refresh(); d(x); }} />} />;
  }
  const n = items.length;
  const run = () => void batch.run("batch", () => applyAll(reason, items.map((s) => s.id)), (r: BatchResult) => { setResult({ r, reason, n }); env.ask.set(null); refresh(); return { text: "", toast: "" }; });
  return (
    <>
      {result && (
        <div className="cl-result" role="status" data-testid="batch-result">
          Erased {result.r.erased} of {result.n} with one reason for the whole batch: {eraseReasonWords(result.reason)}.
          {result.r.others.length > 0 && <> {result.r.others.length} could not be erased and {result.r.others.length === 1 ? "was" : "were"} left as {result.r.others.length === 1 ? "it was" : "they were"}.</>}
        </div>
      )}
      <Section read={read} count={n} page={page} extra={
        <div className="cl-bulk">
          <div className="rm-actions">
            <ReviewButton n={n} onStart={() => { env.ask.set(null); setMode("review"); }} />
            <button type="button" className="danger" data-testid="apply-all" disabled={n === 0 || batch.busy || off || asking} onClick={() => env.ask.set(allKey)}>Apply to all {n}</button>
          </div>
          <p className="meta" data-testid="one-reason-note">Apply to all uses one reason for the whole batch. To give each its own reason, review them one at a time.</p>
          {asking && (
            <div className="rm-erase" data-testid="apply-panel">
              <LostStaysBox ls={ERASE_SOURCE} />
              <Choice legend={`One reason for all ${n} sources`} name="batch-reason" value={reason} onChange={setReason} options={ERASE_REASONS} testid="batch-reason" />
              <p data-testid="batch-says">All {n} {n === 1 ? "source is" : "sources are"} erased with this one reason: {eraseReasonWords(reason)}. No note is kept with a batch.</p>
              <TypedConfirm key={allKey} word={ERASE_WORD} prompt={`This erases all ${n} sources in this list for good.`} confirmLabel={`Erase all ${n} for good`}
                onCancel={() => env.ask.set(null)} onConfirm={run} />
              {batch.err && <p className="rm-err" role="alert" data-testid="batch-error">{batch.err}</p>}
            </div>
          )}
        </div>}>
        {items.map((s) => <li key={s.id}><ReadyCard s={s} env={env} onDone={onDone} /></li>)}
      </Section>
    </>
  );
}

function ReopenTab({ env, tick, refresh }: { env: Env; tick: number; refresh: () => void }) {
  const cands = useRead(readCandidates, tick);
  const gone = useRead(() => readDismissals("reopen_candidate"), tick);
  const [mode, setMode] = useState<"list" | "review">("list");
  const onDone = useListDone(refresh);
  const read: Read<unknown> & { retry: () => void } = cands.state === "failed" || gone.state === "failed" ? { state: "failed", retry: () => { cands.retry(); gone.retry(); } }
    : cands.state === "ok" && gone.state === "ok" ? { state: "ok", data: null, retry: cands.retry } : { state: "loading", retry: cands.retry };
  // a dismissed one does not come back for this person: the dismissals are read from the server, so another person's list is whole
  const items = cands.state === "ok" && gone.state === "ok" ? cands.data.filter((c) => !gone.data.has(c.tombstoneId)) : [];
  const page: Page = { title: "Worth reopening", empty: "Nothing is worth reopening right now.", note: "Erased sources whose address came back with new evidence." };
  if (mode === "review") {
    return <Review items={items} idOf={(c) => c.tombstoneId} refresh={refresh} onStep={() => env.ask.set(null)} onClose={() => { env.ask.set(null); setMode("list"); }}
      render={(c, d) => <CandidateCard c={c} env={env} onDone={(x) => { refresh(); d(x); }} />} />;
  }
  return (
    <Section read={read} count={items.length} page={page} extra={<div className="rm-actions"><ReviewButton n={items.length} onStart={() => { env.ask.set(null); setMode("review"); }} /></div>}>
      {items.map((c) => <li key={c.tombstoneId}><CandidateCard c={c} env={env} onDone={onDone} /></li>)}
    </Section>
  );
}

function FlaggedTab({ env, tick, refresh }: { env: Env; tick: number; refresh: () => void }) {
  const read = useRead(readFlags, tick);
  const [mode, setMode] = useState<"list" | "review">("list");
  const onDone = useListDone(refresh);
  const items = read.state === "ok" ? read.data : [];
  const page: Page = { title: "Flagged by you", empty: "You have not flagged anything.", note: "Only you and admins can see your flags. A flag changes nothing about what you flagged." };
  if (mode === "review") {
    return <Review items={items} idOf={(f) => f.id} refresh={refresh} onStep={() => env.ask.set(null)} onClose={() => setMode("list")}
      render={(f, d) => <FlagCard f={f} env={env} onDone={(x) => { refresh(); d(x); }} />} />;
  }
  return (
    <Section read={read} count={items.length} page={page} extra={<div className="rm-actions"><ReviewButton n={items.length} onStart={() => { env.ask.set(null); setMode("review"); }} /></div>}>
      {items.map((f) => <li key={f.id}><FlagCard f={f} env={env} onDone={onDone} /></li>)}
    </Section>
  );
}

function SuggestionsTab({ tick }: { tick: number }) {
  const all = useRead(readSuggestions, tick);
  const gone = useRead(() => readDismissals("suggestion"), tick);
  const read: Read<unknown> & { retry: () => void } = all.state === "failed" || gone.state === "failed" ? { state: "failed", retry: () => { all.retry(); gone.retry(); } }
    : all.state === "ok" && gone.state === "ok" ? { state: "ok", data: null, retry: all.retry } : { state: "loading", retry: all.retry };
  const items = all.state === "ok" && gone.state === "ok" ? visibleSuggestions(all.data, gone.data) : [];
  return (
    <Section read={read} count={items.length} page={{ title: "Suggestions", empty: "No suggestions yet. When the library scan runs, what it finds (duplicates, dead links, weak sources) will be listed here. Anything you dismiss stays dismissed for you.",
      note: "Suggestions only propose: nothing changes until you decide." }}>
      {items.map((s) => <li key={s.key} className="rm-row" data-testid="card-suggestion"><span className="row-title">{s.title}</span></li>)}
    </Section>
  );
}

export function Cleanup({ subject, ready }: { subject: string | null; ready: boolean }) {
  const [tab, setTab] = useState<Tab>("suggestions");
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [reasons, setReasons] = useState<ReasonWords | null>(null);
  const refresh = () => setTick((n) => n + 1);
  useEffect(() => { let live = true; readReasonWords().then((m) => { if (live) setReasons(m); }, () => { if (live) setReasons(null); }); return () => { live = false; }; }, []);
  const env: Env = { subject, ask: { open, set: setOpen }, reasons };
  const pick = (t: Tab) => { setOpen(null); setTab(t); };
  return (
    <section className="screen cleanup" data-testid="cleanup">
      <h1>Cleanup</h1>
      <p className="lead">Work through what could be tidied: your flags, sources ready to erase, and erased sources worth a second look. Nothing is erased until you confirm it.</p>
      <div role="tablist" aria-label="Cleanup" className="rm-tabs"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          const at = TABS.findIndex(([t]) => t === tab), n = TABS[(at + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length][0];
          pick(n); document.getElementById("cl-tab-" + n)?.focus(); e.preventDefault();
        }}>
        {TABS.map(([t, label]) => (
          <button key={t} type="button" role="tab" id={"cl-tab-" + t} aria-selected={tab === t} tabIndex={tab === t ? 0 : -1} aria-controls={"cl-panel-" + t} data-testid={"tab-" + t}
            onClick={() => pick(t)}>{label}</button>
        ))}
      </div>
      <div role="tabpanel" id={"cl-panel-" + tab} aria-labelledby={"cl-tab-" + tab} className="rm-tab">
        {!ready ? <p className="meta" role="status">Loading...</p>
          : tab === "suggestions" ? <SuggestionsTab tick={tick} />
          : tab === "flagged" ? <FlaggedTab env={env} tick={tick} refresh={refresh} />
          : tab === "ready" ? <ReadyTab env={env} tick={tick} refresh={refresh} />
          : <ReopenTab env={env} tick={tick} refresh={refresh} />}
      </div>
    </section>
  );
}

// The route's screen (routes.ts `screen`): keyed by the signed-in person, so a change of person starts from nothing:
// every open dialog, typed word, draft, review and in-flight answer is dropped with the old screen.
export function CleanupScreen({ subject, whoAnswered }: ScreenProps) {
  return <Cleanup key={subject ?? ""} subject={subject} ready={whoAnswered} />;
}
