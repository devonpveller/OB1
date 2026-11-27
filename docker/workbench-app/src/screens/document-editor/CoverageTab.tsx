// The Coverage tab of the document screen (rwr-doc-coverage): what this document still needs.
//   - your gaps: a box ("Add gap") and "Add as a gap" for the text selected in the writing surface (the gap IS the passage;
//     "Show in the text" selects it again); tick some and "Research the N ticked gaps (one run)" - ONE run for all of them;
//   - being researched: the gaps a run has, with the run; they rotate out on their own: when the run has finished and found
//     the answer from two agreeing sources they are "covered", otherwise they come back to your list (the server decides, on a read);
//   - found by research: what the person's own research runs for this document say is still needed, each with the run it came
//     from. NEVER added by themselves: only "Add to my gaps" puts one on the list.
// The tab's number is the count of OPEN gaps (never shown while it is unknown). Everything here belongs to the person who opened
// the document: the screen is keyed by the subject (a change of person unmounts it, and with it every draft, tick, question and
// message), a read that comes back after the screen is gone is dropped, and every write first re-reads who is signed in.
// Nothing is kept in the browser.
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../../shell/Toast";
import { isSamePerson } from "./editor-data";
import {
  addGap, chars, cleanText, gapProblem, GAP_MAX, markGap, normalizeGapText, POLL_MS, readFound, readGaps, removeGap, researchGaps, runDate,
  type Found, type Gap, type GapList,
} from "./coverage-data";
import "./coverage.css";

export type CoverageCtx = {
  path: string;
  subject: string;
  selection: string;                 // the text selected in the writing surface ("" = none)
  locate: (passage: string) => boolean; // select that passage in the writing surface; false = it is not in the text any more
};

const NOT_SAME = "Not sent: this page could not confirm that you are still the person who opened this document. Nothing was sent.";
type Read = { s: "loading" } | { s: "failed" } | { s: "ready"; list: GapList };

// The tab's state. Lives in InThisDoc so the tab's number is there when another tab is showing.
export function useCoverage(ctx: CoverageCtx | null) {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [read, setRead] = useState<Read>({ s: "loading" });
  const [ticked, setTicked] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const alive = useRef(true);
  const gen = useRef(0);
  const working = useRef(false);
  const path = ctx?.path ?? "", subject = ctx?.subject ?? "";

  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++gen.current;
    try {
      const list = await readGaps(path);
      if (!alive.current || mine !== gen.current) return;
      setRead({ s: "ready", list });
      setTicked((t) => t.filter((id) => list.gaps.some((g) => g.id === id && g.state === "open")));
      setRemoving((r) => (r && list.gaps.some((g) => g.id === r) ? r : null));
    } catch {
      if (alive.current && mine === gen.current) setRead((r) => (r.s === "ready" ? r : { s: "failed" }));
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    setRead({ s: "loading" }); setTicked([]); setErr(""); setRemoving(null);
    void load();
    return () => { alive.current = false; gen.current++; };
  }, [load, subject]);

  const researching = read.s === "ready" && read.list.counts.researching > 0;
  useEffect(() => {
    if (!researching) return;
    const h = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(h);
  }, [researching, load]);

  // every write: one at a time, for the person who opened the document only; then the list is read again
  const run = useCallback(async (what: "add" | "research" | "change" | "remove", f: () => Promise<boolean | void>): Promise<boolean> => {
    if (working.current) return false;
    working.current = true; setBusy(true); setErr("");
    let ok = false;
    try {
      if (!(await isSamePerson(subject))) { if (alive.current) setErr(NOT_SAME); return false; }
      ok = (await f()) !== false;
    } catch (e) {
      if (alive.current) setErr(gapProblem(e, what));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
    if (alive.current) await load();
    return ok;
  }, [subject, load]);

  const add = (text: string, origin: "user" | "selection" | "research") => run("add", async () => {
    const t = cleanText(text);
    if (!t) return false;
    if (chars(t) > GAP_MAX) { setErr(`That is longer than ${GAP_MAX} characters. Use a shorter text.`); return false; }
    await addGap(path, t, origin);
  });
  const mark = (id: string, state: "open" | "covered") => run("change", () => markGap(id, state));
  const remove = (id: string) => run("remove", async () => { setRemoving(null); await removeGap(id); });
  const research = () => run("research", async () => {
    const ids = ticked;
    if (!ids.length) return false;
    const r = await researchGaps(ids);
    setTicked([]);
    toastRef.current({ message: `Research started on ${r.n} ${r.n === 1 ? "gap" : "gaps"} in one run.` });
  });
  const tick = (id: string, on: boolean) => setTicked((t) => (on ? (t.includes(id) ? t : [...t, id]) : t.filter((x) => x !== id)));

  const open = read.s === "ready" ? read.list.counts.open : null;
  return { read, load, ticked, tick, err, setErr, busy, removing, setRemoving, add, mark, remove, research, open };
}
export type CoverageState = ReturnType<typeof useCoverage>;

const ORIGIN: Record<string, string> = { user: "yours", selection: "from the text", research: "from research", scan: "from a scan", topic: "from a topic" };

export function CoverageTab({ cov, ctx }: { cov: CoverageState; ctx: CoverageCtx }) {
  const [draft, setDraft] = useState("");
  const { read, busy } = cov;
  const list = read.s === "ready" ? read.list : null;
  const by = (s: string) => (list ? list.gaps.filter((g) => g.state === s) : []);
  const mine = by("open"), going = by("researching"), done = by("covered");
  const sel = ctx.selection.trim();
  const over = chars(draft.trim()) > GAP_MAX;

  const submit = async () => { if (await cov.add(draft, "user")) setDraft(""); };
  return (
    <div className="cov" data-testid="cov-panel">
      {cov.err && <p className="docs-err" role="alert" data-testid="cov-err">{cov.err}</p>}
      {read.s === "loading" && <p className="meta" role="status">Loading your gaps...</p>}
      {read.s === "failed" && (
        <p className="docs-err" role="alert" data-testid="cov-gaps-err">
          Could not read your gaps. Nothing was changed. <button type="button" onClick={() => void cov.load()}>Try again</button>
        </p>
      )}
      {list && (
        <>
          <section aria-labelledby="cov-h-mine" className="cov-sec">
            <h3 id="cov-h-mine" className="cov-h">Your gaps <span className="meta">{mine.length === 1 ? "1 open" : `${mine.length} open`}</span></h3>
            <div className="cov-add">
              <label className="meta" htmlFor="cov-box">A question this document still has to answer</label>
              <textarea id="cov-box" data-testid="cov-box" rows={2} value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)}
                aria-describedby="cov-box-note" />
              <p id="cov-box-note" className={"meta" + (over ? " cov-over" : "")}>{over ? `${chars(draft.trim())} characters: at most ${GAP_MAX}.` : `At most ${GAP_MAX} characters.`}</p>
              <div className="cov-acts">
                <button type="button" className="btn sm pri" data-testid="cov-add" disabled={busy || !draft.trim() || over} onClick={() => void submit()}>Add gap</button>
                <button type="button" className="btn sm" data-testid="cov-add-sel" disabled={busy || !sel}
                  title={sel ? "Adds the selected words as a gap" : "Select some text in the document first"} onClick={() => void cov.add(sel, "selection")}>Add as a gap</button>
                <span className="meta">{sel ? `${chars(sel)} characters selected` : "Select text in the document to add it."}</span>
              </div>
            </div>
            {mine.length === 0 ? <p className="meta" data-testid="cov-none">No open gaps. Add one above, or from what research found below.</p> : (
              <ul className="cov-list" data-testid="cov-mine">
                {mine.map((g) => <GapRow key={g.id} g={g} cov={cov} ctx={ctx} />)}
              </ul>
            )}
            <div className="cov-acts">
              <button type="button" className="btn sm pri" data-testid="cov-research" disabled={busy || cov.ticked.length === 0 || cov.removing !== null} onClick={() => void cov.research()}>
                {cov.ticked.length === 0 ? "Research the ticked gaps (one run)" : `Research the ${cov.ticked.length} ticked ${cov.ticked.length === 1 ? "gap" : "gaps"} (one run)`}
              </button>
              <button type="button" className="btn sm" data-testid="cov-recheck" disabled={busy} onClick={() => void cov.load()}>Check again</button>
            </div>
          </section>
          {going.length > 0 && (
            <section aria-labelledby="cov-h-going" className="cov-sec">
              <h3 id="cov-h-going" className="cov-h">Being researched <span className="meta">{going.length}</span></h3>
              <p className="meta">A gap rotates out when its run has finished and found an answer backed by two agreeing sources. If the run does not, it comes back to your list.</p>
              <ul className="cov-list" data-testid="cov-researching">
                {going.map((g) => <GapRow key={g.id} g={g} cov={cov} ctx={ctx} />)}
              </ul>
            </section>
          )}
          {done.length > 0 && (
            <section aria-labelledby="cov-h-done" className="cov-sec">
              <h3 id="cov-h-done" className="cov-h">Covered <span className="meta">{done.length}</span></h3>
              <ul className="cov-list" data-testid="cov-covered">
                {done.map((g) => <GapRow key={g.id} g={g} cov={cov} ctx={ctx} />)}
              </ul>
            </section>
          )}
        </>
      )}
      <FoundByResearch cov={cov} ctx={ctx} open={list ? list.gaps.filter((g) => g.state === "open" || g.state === "researching") : []} />
    </div>
  );
}

function GapRow({ g, cov, ctx }: { g: Gap; cov: CoverageState; ctx: CoverageCtx }) {
  const [note, setNote] = useState("");
  const confirming = cov.removing === g.id;
  const locked = cov.removing !== null && !confirming; // another gap's question is open: the other destructive buttons wait
  const show = () => setNote(ctx.locate(g.text) ? "" : "That passage is no longer in the text.");
  return (
    <li className="cov-row" data-testid={"gap-" + g.id}>
      <div className="cov-line">
        {g.state === "open" && (
          <input type="checkbox" data-testid={"gap-tick-" + g.id} checked={cov.ticked.includes(g.id)} disabled={cov.busy}
            aria-label={"Research: " + g.text} onChange={(e) => cov.tick(g.id, e.target.checked)} />
        )}
        <span className="cov-text">{g.text}</span>
      </div>
      <div className="cov-sub">
        <span className="pill">{ORIGIN[g.origin] ?? g.origin}</span>
        {g.state === "researching" && g.job_id && <span className="meta" data-testid="gap-run" data-run={g.job_id}>run {g.job_id.slice(0, 8)}</span>}
        {g.origin === "selection" && <button type="button" className="btn sm" onClick={show}>Show in the text</button>}
        {g.state !== "covered" && <button type="button" className="btn sm" disabled={cov.busy} onClick={() => void cov.mark(g.id, "covered")}>Mark covered</button>}
        {g.state === "covered" && <button type="button" className="btn sm" disabled={cov.busy} onClick={() => void cov.mark(g.id, "open")}>Reopen</button>}
        {g.state !== "researching" && !confirming && (
          <button type="button" className="btn sm danger-line" disabled={cov.busy || locked} onClick={() => cov.setRemoving(g.id)}>Remove</button>
        )}
      </div>
      {confirming && (
        <div className="cov-confirm" role="group" aria-label="Remove this gap?">
          <span>Remove this gap from your list?</span>
          <button type="button" className="btn sm danger-line" data-testid={"gap-remove-ok-" + g.id} disabled={cov.busy} onClick={() => void cov.remove(g.id)}>Remove</button>
          <button type="button" className="btn sm" onClick={() => cov.setRemoving(null)}>Keep</button>
        </div>
      )}
      {note && <p className="meta" role="status">{note}</p>}
    </li>
  );
}

type FoundRead = { s: "loading" } | { s: "failed" } | { s: "ready"; found: Found[]; unread: number };

function FoundByResearch({ cov, ctx, open }: { cov: CoverageState; ctx: CoverageCtx; open: Gap[] }) {
  const [f, setF] = useState<FoundRead>({ s: "loading" });
  const { path, subject } = ctx;
  const gen = useRef(0);
  const reload = useCallback(() => {
    const mine = ++gen.current;
    readFound(path).then(
      (r) => { if (mine === gen.current) setF({ s: "ready", ...r }); },
      () => { if (mine === gen.current) setF({ s: "failed" }); },
    );
  }, [path]);
  useEffect(() => { setF({ s: "loading" }); reload(); return () => { gen.current++; }; }, [reload, subject]);
  const onList = new Set(open.map((g) => normalizeGapText(g.text)));
  return (
    <section aria-labelledby="cov-h-found" className="cov-sec">
      <h3 id="cov-h-found" className="cov-h">Found by research</h3>
      <p className="meta">What your research runs on this document say is still needed. Nothing here is on your list until you add it.</p>
      {f.s === "loading" && <p className="meta" role="status">Reading your research runs...</p>}
      {f.s === "failed" && (
        <p className="docs-err" role="alert" data-testid="cov-found-err">Could not read what your research runs found. <button type="button" onClick={reload}>Try again</button></p>
      )}
      {f.s === "ready" && f.unread > 0 && <p className="meta" role="status" data-testid="cov-found-partial">{f.unread === 1 ? "One research run" : `${f.unread} research runs`} could not be read, so this list may be incomplete.</p>}
      {f.s === "ready" && f.found.length === 0 && <p className="meta" data-testid="cov-found-none">Your research runs on this document have no open needs.</p>}
      {f.s === "ready" && f.found.length > 0 && (
        <ul className="cov-list" data-testid="cov-found">
          {f.found.map((n) => {
            const there = onList.has(n.key);
            return (
              <li key={n.key} className="cov-row" data-testid="need">
                <div className="cov-line"><span className="cov-text">{n.text}</span></div>
                <div className="cov-sub">
                  <span className="pill">{n.kind === "gap" ? "a gap the run listed" : n.status === "partial" ? "partly answered" : n.status === "search_failed" ? "the search failed" : "not answered"}</span>
                  <span className="meta" data-testid="need-run" data-run={n.run}>Run of {runDate(n.at)}</span>
                  {there ? <span className="meta">On your list</span> : (
                    <button type="button" className="btn sm" disabled={cov.busy} onClick={() => void cov.add(n.text, "research")}>Add to my gaps</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
