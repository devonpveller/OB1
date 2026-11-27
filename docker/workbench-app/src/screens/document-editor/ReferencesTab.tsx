// The References tab of the document screen (rwr-doc-refs): three lists.
//   To place        the cites gathered anywhere that wait in THIS document's queue; "Place at cursor" pins a reference
//                   record and puts its citation where the cursor is (the queue row leaves in the same server step).
//   Cited           the references the document holds, in the server's order, with the section of the text each one
//                   sits in and a quality note; an attached one can be removed, a cited one is removed by deleting its
//                   citation from the text; "Re-pin" first SHOWS what changed (diff-check) and only then moves the pin.
//   Find sources    a search over sources the document does not cite yet; "Add to references" puts one in the queue.
// A title opens the source in the side drawer (until the Source screen lands). Nothing here is kept in the browser: every
// list, draft, confirmation and view lives in this component, which is gone when the person changes (the screen is keyed
// by the subject). EVERY write re-reads who is signed in first (ifSamePerson), exactly as the writing surface does.
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ApiError } from "../../lib/api";
import { EditorSelection, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { protectedSpans } from "../../editor/protected";
import type { DrawerTarget } from "./SourceDrawer";
import {
  addPendingRow, diffCheck, findCandidates, placePending, readChunk, readHolders, readPending, readPinnedWords, readQuality, readSourceTitle,
  removeAttached, removePending, repin, sectionOf, why, type Candidate, type Diff, type HolderRow, type PendingRow,
} from "./refs-data";

type Load<T> = { s: "loading" } | { s: "failed" } | { s: "ready"; v: T };
type Quality = { s: "ok"; value: number | null; family: string; reason: string } | { s: "failed" };
type PinView =
  | { ref: string; s: "loading" }
  | { ref: string; s: "failed" }
  | { ref: string; s: "ready"; diff: Diff; before: string; after: string };
type Finding = { s: "idle" } | { s: "busy" } | { s: "failed" } | { s: "ready"; q: string; found: Candidate[] };
type Confirm = { kind: "queue" | "attached"; id: string } | null;

export type ReferencesTabProps = {
  path: string;
  body: string;                                // the text as of the last render: what the lists show
  getBody: () => string;                       // the text RIGHT NOW: every action reads this, never `body`
  view: MutableRefObject<EditorView | null>;
  save: (commit: boolean) => Promise<boolean>; // the writing surface's own save: the server's holders follow the saved text
  ifSamePerson: <T>(write: () => Promise<T> | T) => Promise<{ ran: true; value: T } | { ran: false }>;
  openSource: (t: DrawerTarget) => void;      // the side drawer
};

const NOT_SAME = "Not sent: this page could not confirm that you are still the person who opened this document. Nothing was changed.";
const QUALITY_LANES = 4;

export function ReferencesTab({ path, body, getBody, view, save, ifSamePerson, openSource }: ReferencesTabProps) {
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [pending, setPending] = useState<Load<PendingRow[]>>({ s: "loading" });
  const [holders, setHolders] = useState<Load<HolderRow[]>>({ s: "loading" });
  const [titles, setTitles] = useState<Record<string, string | null>>({});
  const [newer, setNewer] = useState<Map<string, Diff>>(new Map());
  const [quality, setQuality] = useState<Record<string, Quality>>({});
  const [msg, setMsg] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [pin, setPin] = useState<PinView | null>(null);
  const [q, setQ] = useState("");
  const [hint, setHint] = useState("");
  const [find, setFind] = useState<Finding>({ s: "idle" });
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const asked = useRef<Set<string>>(new Set());

  const loadPending = useCallback(async () => {
    try {
      const r = await readPending(path);
      if (!live.current) return;
      setPending({ s: "ready", v: r.rows });
      // titles are read again on EVERY read of the queue: a source that has become unreadable since must not keep its old title
      for (const sid of new Set(r.rows.flatMap((x) => (x.source_id ? [x.source_id] : [])))) {
        readSourceTitle(sid).then((t) => { if (live.current) setTitles((m) => ({ ...m, [sid]: t })); }, () => {});
      }
    } catch { if (live.current) setPending({ s: "failed" }); }
  }, [path]);
  const loadHolders = useCallback(async () => {
    try {
      const rows = await readHolders(path);
      if (!live.current) return;
      setHolders({ s: "ready", v: rows });
      // one diff-check for the whole list: which pins have a newer revision
      diffCheck(rows.map((r) => r.reference_id)).then((m) => { if (live.current) setNewer(m); }, () => { if (live.current) setNewer(new Map()); });
    } catch { if (live.current) setHolders({ s: "failed" }); }
  }, [path]);
  const reload = useCallback(() => Promise.all([loadPending(), loadHolders()]).then(() => undefined), [loadPending, loadHolders]);
  useEffect(() => { void loadPending(); void loadHolders(); }, [loadPending, loadHolders]);

  // the quality note of every cited source, read once each
  useEffect(() => {
    if (holders.s !== "ready") return;
    const todo = [...new Set(holders.v.map((h) => h.source_id))].filter((s) => !asked.current.has("q" + s));
    todo.forEach((s) => asked.current.add("q" + s));
    let next = 0;
    const lane = async () => {
      while (live.current && next < todo.length) {
        const sid = todo[next++];
        try { const r = await readQuality(sid); if (live.current) setQuality((m) => ({ ...m, [sid]: { s: "ok", ...r } })); }
        catch { if (live.current) setQuality((m) => ({ ...m, [sid]: { s: "failed" } })); }
      }
    };
    for (let i = 0; i < Math.min(QUALITY_LANES, todo.length); i++) void lane();
  }, [holders]);

  const citedIds = useMemo(() => new Set(holders.s === "ready" ? holders.v.map((h) => h.source_id.toLowerCase()) : []), [holders]);
  const queuedSources = useMemo(() => new Set(pending.s === "ready" ? pending.v.flatMap((r) => (r.source_id ? [r.source_id.toLowerCase()] : [])) : []), [pending]);
  const order = useMemo(() => [...new Set(protectedSpans(body).map((s) => s.reference_id))], [body]);
  const open = (kind: DrawerTarget["kind"], id: string) => openSource({ kind, id, n: kind === "reference" ? order.indexOf(id.toLowerCase()) + 1 : 0 });
  const locked = confirm !== null || busy;
  // a confirmation belongs to its target: when the target is no longer in its list (placed or removed elsewhere) it is dropped, or
  // it would keep every destructive button disabled with nothing on screen to answer
  useEffect(() => {
    if (!confirm) return;
    const known = confirm.kind === "queue" ? pending.s === "ready" : holders.s === "ready";
    const here = confirm.kind === "queue" ? pending.s === "ready" && pending.v.some((r) => r.id === confirm.id)
      : holders.s === "ready" && holders.v.some((h) => h.reference_id === confirm.id && h.origin === "added");
    if (known && !here) setConfirm(null);
  }, [confirm, pending, holders]);

  // ── writes: each re-reads who is signed in; a refusal or a failure says so and changes nothing ──
  const write = async <T,>(what: () => Promise<T>, failed: string): Promise<{ ok: true; v: T } | { ok: false }> => {
    setMsg("");
    const r = await ifSamePerson(what).catch((e) => ({ ran: true as const, error: e }));
    if (!live.current) return { ok: false };
    if (!r.ran) { setMsg(NOT_SAME); return { ok: false }; }
    if ("error" in r) { setMsg(why(r.error, failed)); await reload(); return { ok: false }; }
    return { ok: true, v: r.value as T };
  };
  const afterTextChange = async () => {
    // the file is written so the server's holders follow the text, then the lists are read again
    await save(false);
    if (live.current) await reload();
  };

  const place = async (row: PendingRow) => {
    const v = view.current;
    if (!v) { setMsg("The text box is not ready yet."); return; }
    // the cursor is read NOW, at the click: where the person pointed is where the citation goes. It is carried through every change
    // made to the text while the answer is on its way (CodeMirror's own position mapping), so an edit above it, or a repeated
    // passage, cannot move the citation to another place.
    let pos = v.state.selection.main.head;
    if (pos === 0 && v.state.doc.length > 0) { setMsg("Click in the text where the citation should go, then place it."); return; }
    let tracking = true;
    v.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of((u) => { if (tracking && u.docChanged) pos = u.changes.mapPos(pos, -1); })) });
    setBusy(true);
    const r = await write(() => placePending(row.id), "Not placed: the citation could not be made. It is still waiting.");
    tracking = false;
    if (r.ok) {
      const now = view.current;
      if (!now) { setMsg("The citation was made but the text box had closed; it was not put in the text. It will drop out of the references."); await reload(); }
      else {
        const at = Math.min(pos, now.state.doc.length);
        const insert = r.v.insert;
        now.dispatch({ changes: { from: at, insert }, selection: EditorSelection.cursor(at + insert.length), userEvent: "input.inject" });
        // the file is written so the server's holders follow the text; when it cannot be written (changed elsewhere, a failed
        // write) nothing was placed: the citation comes back out of the text and the cite goes back in the queue
        const saved = await save(false);
        if (!live.current) return;
        if (saved) { view.current?.focus(); setMsg("Placed. The citation is in the text at the cursor."); await reload(); }
        else {
          // the citation is found by its own unique token, wherever the person's typing has moved it
          const cur = view.current;
          const i = cur ? cur.state.doc.toString().indexOf(insert) : -1;
          if (cur && i >= 0) {
            cur.dispatch({ changes: { from: i, to: i + insert.length, insert: "" } });
            const back = await ifSamePerson(() => addPendingRow(path, row, "requeue")).catch((e) => ({ ran: true as const, error: e }));
            if (!live.current) return;
            const dup = !back.ran ? false : "error" in back && back.error instanceof ApiError && back.error.status === 409;
            setMsg("Not placed: the document could not be saved (see the message above), so the citation was taken back out of the text. " +
              (back.ran && (!("error" in back) || dup) ? (dup ? "It is already waiting in To place." : "The cite is back in To place.")
                : "The cite could not be put back in To place; add it again from its source."));
          } else {
            setMsg("Not placed: the document could not be saved (see the message above), and the citation is no longer in the text, so it was not put back in To place.");
          }
          await reload();
        }
      }
    }
    if (live.current) setBusy(false);
  };

  const removeQueued = async (row: PendingRow) => {
    setConfirm(null); setBusy(true);
    const r = await write(() => removePending(row.id), "Not removed. It is still waiting.");
    if (r.ok) { setMsg("Removed from To place."); await loadPending(); }
    if (live.current) setBusy(false);
  };
  const removeAttachedRef = async (ref: string) => {
    setConfirm(null); setBusy(true);
    const r = await write(() => removeAttached(path, ref), "Not removed. It is still attached.");
    if (r.ok) { setMsg("Removed from the references."); await save(false); await loadHolders(); }
    if (live.current) setBusy(false);
  };

  const showPin = async (ref: string) => {
    setMsg("");
    if (sectionOf(getBody(), ref) === null) { setPin(null); setMsg("That citation is not in the text any more, so there is nothing to re-pin."); return; }
    setPin({ ref, s: "loading" });
    try {
      const diff = (await diffCheck([ref])).get(ref);
      if (!diff) throw new Error("no answer");
      const [before, after] = await Promise.all([
        readPinnedWords(ref),
        diff.equivalent_current_chunk_id ? readChunk(diff.equivalent_current_chunk_id).catch(() => "") : Promise.resolve(""),
      ]);
      if (live.current) setPin((cur) => (cur && cur.ref === ref ? { ref, s: "ready", diff, before, after } : cur));
    } catch { if (live.current) setPin((cur) => (cur && cur.ref === ref ? { ref, s: "failed" } : cur)); }
  };
  const movePin = async (ref: string, shown: number | null) => {
    setBusy(true);
    setMsg("");
    // nothing at all is sent for a person who is not the one who opened the document (not even the re-check below)
    if (!(await ifSamePerson(() => true)).ran) { if (live.current) { setMsg(NOT_SAME); setBusy(false); } return; }
    // the server pins the NEWEST revision at the moment of the click, so the check is run again now: if the source has moved on
    // since the view was drawn, nothing moves and the view is drawn again for what is there now
    let d: Diff | undefined;
    try { d = (await diffCheck([ref])).get(ref); } catch { d = undefined; }
    if (!live.current) return;
    if (!d || !d.out_of_date || d.anchor !== "requoted" || d.current_revision !== shown) {
      setBusy(false);
      await showPin(ref);
      if (live.current) setMsg(d ? "The source changed since you looked, so nothing was moved. This is what it says now." : "What changed could not be re-checked, so nothing was moved.");
      return;
    }
    if (sectionOf(getBody(), ref) === null) { setPin(null); setBusy(false); setMsg("That citation is not in the text any more, so nothing was moved."); return; }
    const r = await write(() => repin(path, ref), "The pin was not moved. Nothing changed.");
    if (r.ok) {
      const v = view.current;
      const span = v ? protectedSpans(v.state.doc.toString()).find((s) => s.reference_id === ref.toLowerCase()) : undefined;
      if (v && span) {
        const text = span.kind === "transclusion" ? r.v.insert : `[@ref:${r.v.record.id}]`;
        v.dispatch({ changes: { from: span.from, to: span.to, insert: text } });
        setPin(null);
        setMsg("The pin moved to the newest revision, and the text now cites the new one.");
        await afterTextChange();
      } else { setPin(null); setMsg("That citation is not in the text any more, so nothing was replaced."); await reload(); }
    }
    if (live.current) setBusy(false);
  };

  const search = async () => {
    const term = q.trim();
    if (term.length < 2) { setHint("Type at least two letters to look for sources."); return; }
    setHint(""); setFind({ s: "busy" });
    try {
      // what the document cites is read again NOW (another browser may have attached a source since this tab loaded); when it
      // cannot be read no result is shown, because it could include a source already cited
      const rows = await readHolders(path);
      if (!live.current) return;
      setHolders({ s: "ready", v: rows });
      const found = await findCandidates(path, term);
      if (live.current) setFind({ s: "ready", q: term, found });
    } catch { if (live.current) setFind({ s: "failed" }); }
  };
  const add = async (sid: string) => {
    setAdding(sid);
    try {
      const rows = await readHolders(path);
      if (!live.current) return;
      setHolders({ s: "ready", v: rows });
      if (rows.some((h) => h.source_id.toLowerCase() === sid.toLowerCase())) { setMsg("Not added: this document already cites that source."); setAdding(null); return; }
    } catch { if (live.current) { setMsg("Not added: what the document already cites could not be checked."); setAdding(null); } return; }
    const r = await ifSamePerson(() => addPendingRow(path, { source_id: sid, claim_id: null, section: "", quote: "" }, "find")).catch((e) => ({ ran: true as const, error: e }));
    if (!live.current) return;
    if (!r.ran) setMsg(NOT_SAME);
    else if ("error" in r && !(r.error instanceof ApiError && r.error.status === 409)) setMsg(why(r.error, "Not added. Try again."));
    else setMsg("");
    if (!r.ran) { setAdding(null); return; }
    await loadPending();
    if (live.current) setAdding(null);
  };

  const sources = find.s === "ready" ? find.found.filter((c) => (c.kind === "source" || c.kind === "report") && !citedIds.has(c.id.toLowerCase())) : [];

  return (
    <div className="refs" data-testid="refs-tab">
      {msg && <p className="meta refs-msg" role="status" data-testid="refs-msg">{msg}</p>}

      <section aria-labelledby="refs-toplace">
        <h3 id="refs-toplace" className="sec">To place</h3>
        {pending.s === "loading" && <p className="meta" role="status">Loading...</p>}
        {pending.s === "failed" && (
          <p className="docs-err" role="alert" data-testid="toplace-failed">The waiting cites could not be read. <button type="button" onClick={() => void loadPending()}>Try again</button></p>
        )}
        {pending.s === "ready" && pending.v.length === 0 && <p className="meta" data-testid="toplace-empty">Nothing is waiting to be placed. Cites you add from anywhere wait here.</p>}
        {pending.s === "ready" && pending.v.length > 0 && (
          <ul className="refs-list" data-testid="toplace-list">
            {pending.v.map((r) => (
              <li key={r.id} className="refs-row" data-testid="toplace-row" data-id={r.id}>
                {r.source_id ? (
                  titles[r.source_id] === null
                    ? <span className="refs-title meta" data-testid={`toplace-title-${r.id}`}>A source that is not available any more</span>
                    : <button type="button" className="refs-title linkish" data-testid={`toplace-title-${r.id}`} disabled={titles[r.source_id] === undefined}
                        onClick={() => open("source", r.source_id!)}>{titles[r.source_id] ?? "Loading..."}</button>
                ) : <span className="refs-title" data-testid={`toplace-kind-${r.id}`}>A claim (it cites the source it states from)</span>}
                {(r.section || r.quote) && <span className="meta refs-note">{[r.section && `For: ${r.section}`, r.quote && `"${r.quote}"`].filter(Boolean).join(" · ")}</span>}
                <span className="refs-acts">
                  <button type="button" className="btn sm pri" data-testid={`place-${r.id}`} disabled={locked} onClick={() => void place(r)}>Place at cursor</button>
                  <button type="button" className="btn sm danger-line" data-testid={`toplace-remove-${r.id}`} disabled={locked} onClick={() => setConfirm({ kind: "queue", id: r.id })}>Remove</button>
                </span>
                {confirm?.kind === "queue" && confirm.id === r.id && (
                  <div className="refs-confirm" role="group" aria-label="Confirm removal" data-testid={`confirm-${r.id}`}>
                    <span>Take {r.source_id ? <strong>{titles[r.source_id] ?? "this source"}</strong> : "this claim"} out of To place? It is not cited anywhere yet.</span>
                    <span className="refs-acts">
                      <button type="button" className="btn sm danger-line" data-testid="confirm-yes" onClick={() => void removeQueued(r)}>Remove</button>
                      <button type="button" className="btn sm" data-testid="confirm-no" onClick={() => setConfirm(null)}>Keep it</button>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="refs-cited">
        <h3 id="refs-cited" className="sec">Cited in this document</h3>
        {holders.s === "loading" && <p className="meta" role="status">Loading...</p>}
        {holders.s === "failed" && (
          <p className="docs-err" role="alert" data-testid="cited-failed">The references could not be read. <button type="button" onClick={() => void loadHolders()}>Try again</button></p>
        )}
        {holders.s === "ready" && holders.v.length === 0 && <p className="meta" data-testid="cited-empty">This document does not cite anything yet.</p>}
        {holders.s === "ready" && holders.v.length > 0 && (
          <ol className="refs-list" data-testid="cited-list">
            {holders.v.map((h) => {
              const sec = sectionOf(body, h.reference_id);
              const attached = h.origin === "added";
              const nw = newer.get(h.reference_id);
              const qy = quality[h.source_id];
              return (
                <li key={h.reference_id} className="refs-row" data-testid="cited-row" data-ref={h.reference_id}>
                  <button type="button" className="refs-title linkish" data-testid={`cited-title-${h.reference_id}`} onClick={() => open("reference", h.reference_id)}>{h.title || "Untitled source"}</button>
                  <span className="meta refs-note" data-testid={`cited-section-${h.reference_id}`}>
                    {attached ? "Attached: not in the text" : sec === null ? "Not in the text any more" : sec ? `In: ${sec}` : "In: before the first heading"}
                    {` · pinned at revision ${h.pinned_revision}`}
                  </span>
                  {nw?.out_of_date && <span className="meta refs-newer" data-testid={`cited-newer-${h.reference_id}`}>A newer revision exists (revision {nw.current_revision}).</span>}
                  <span className="meta refs-note" data-testid={`cited-quality-${h.reference_id}`}>
                    {qy === undefined ? "Quality: loading..." : qy.s === "failed" ? "Quality could not be read."
                      : qy.value === null ? "Quality: not rated yet."
                      : `Quality ${Math.round(qy.value * 100) / 100}${qy.family ? ` (${qy.family})` : ""}${qy.reason ? `: ${qy.reason}` : ""}`}
                  </span>
                  <span className="refs-acts">
                    {!attached && sec !== null && (
                      <button type="button" className="btn sm" data-testid={`repin-${h.reference_id}`} onClick={() => void showPin(h.reference_id)}>Re-pin</button>
                    )}
                    {attached && (
                      <button type="button" className="btn sm danger-line" data-testid={`cited-remove-${h.reference_id}`} disabled={locked} onClick={() => setConfirm({ kind: "attached", id: h.reference_id })}>Remove</button>
                    )}
                  </span>
                  {!attached && <span className="meta refs-note" data-testid={`cited-howto-${h.reference_id}`}>To remove it, delete its citation from the text.</span>}
                  {confirm?.kind === "attached" && confirm.id === h.reference_id && (
                    <div className="refs-confirm" role="group" aria-label="Confirm removal" data-testid={`confirm-${h.reference_id}`}>
                      <span>Remove <strong>{h.title || "this source"}</strong> from the references? It is attached, not cited in the text.</span>
                      <span className="refs-acts">
                        <button type="button" className="btn sm danger-line" data-testid="confirm-yes" onClick={() => void removeAttachedRef(h.reference_id)}>Remove</button>
                        <button type="button" className="btn sm" data-testid="confirm-no" onClick={() => setConfirm(null)}>Keep it</button>
                      </span>
                    </div>
                  )}
                  {pin?.ref === h.reference_id && <PinPanel pin={pin} locked={locked} onMove={() => void movePin(h.reference_id, pin.s === "ready" ? pin.diff.current_revision : null)} onCancel={() => setPin(null)} />}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section aria-labelledby="refs-find">
        <h3 id="refs-find" className="sec">Find sources</h3>
        <form className="refs-find" onSubmit={(e) => { e.preventDefault(); void search(); }}>
          <label className="sr-only" htmlFor="refs-find-q">Search for sources</label>
          <input id="refs-find-q" type="search" className="refs-q" data-testid="find-q" value={q} placeholder="Search sources by title or words" onChange={(e) => setQ(e.target.value)} />
          <button type="submit" className="btn sm" data-testid="find-go" disabled={find.s === "busy"}>Find</button>
        </form>
        {hint && <p className="meta" role="status" data-testid="find-hint">{hint}</p>}
        {find.s === "busy" && <p className="meta" role="status">Searching...</p>}
        {find.s === "failed" && <p className="docs-err" role="alert" data-testid="find-failed">The search failed. Try again.</p>}
        {find.s === "ready" && holders.s !== "ready" && <p className="meta" data-testid="find-wait">The list of what this document cites is not loaded, so results are held back: they could include a source already cited.</p>}
        {find.s === "ready" && holders.s === "ready" && sources.length === 0 && <p className="meta" data-testid="find-none">No source matches that which this document does not already cite.</p>}
        {find.s === "ready" && holders.s === "ready" && sources.length > 0 && (
          <ul className="refs-list" data-testid="find-results">
            {sources.map((c) => (
              <li key={c.id} className="refs-row" data-testid="find-row" data-source={c.id}>
                <span data-testid={`find-row-${c.id}`} className="refs-inner">
                  <button type="button" className="refs-title linkish" data-testid={`find-title-${c.id}`} onClick={() => open("source", c.id)}>{c.title || "Untitled source"}</button>
                  {c.snippet && <span className="meta refs-note">{c.snippet}</span>}
                  {c.tags.length > 0 && <span className="meta refs-note" data-testid={`find-tags-${c.id}`}>{c.tags.join(" · ")}</span>}
                  {queuedSources.has(c.id.toLowerCase())
                    ? <span className="meta">Waiting in To place</span>
                    : <span className="refs-acts"><button type="button" className="btn sm" data-testid={`find-add-${c.id}`} disabled={adding !== null} onClick={() => void add(c.id)}>Add to references</button></span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// What changed, before anything moves: the revisions, the words the reference pins, and the text standing for them now.
function PinPanel({ pin, locked, onMove, onCancel }: { pin: PinView; locked: boolean; onMove: () => void; onCancel: () => void }) {
  if (pin.s === "loading") return <div className="refs-diff" data-testid="repin-loading" role="status">Checking what changed...</div>;
  if (pin.s === "failed") {
    return (
      <div className="refs-diff" data-testid={`repin-view-${pin.ref}`}>
        <p className="docs-err" role="alert">What changed could not be read, so the pin was not moved.</p>
        <span className="refs-acts"><button type="button" className="btn sm" data-testid="repin-cancel" onClick={onCancel}>Close</button></span>
      </div>
    );
  }
  const d = pin.diff;
  const can = d.out_of_date && d.anchor === "requoted";
  return (
    <div className="refs-diff" data-testid={`repin-view-${pin.ref}`}>
      <p className="meta" data-testid="repin-revisions">
        {d.out_of_date ? `Pinned at revision ${d.pinned_revision}; the source is now at revision ${d.current_revision}.` : `Pinned at revision ${d.pinned_revision}, which is the newest.`}
      </p>
      {!d.out_of_date && <p>Nothing has changed: the pin is current, so there is nothing to move.</p>}
      {d.out_of_date && can && <p>The pinned words are still in the source. Moving the pin cites revision {d.current_revision}; the text now cites the new reference.</p>}
      {d.out_of_date && d.anchor === "lost" && <p className="docs-err" data-testid="repin-lost">The pinned words are not found in revision {d.current_revision}, so the pin cannot be moved. The citation stays pinned at revision {d.pinned_revision}.</p>}
      {d.out_of_date && d.anchor !== "requoted" && d.anchor !== "lost" && <p>This citation points at the source as a whole, not at pinned words, so there is no passage to move.</p>}
      <h4 className="sec">Pinned words (revision {d.pinned_revision})</h4>
      <blockquote className="drawer-quote" data-testid="repin-before">{pin.before || "(none)"}</blockquote>
      {d.out_of_date && (
        <>
          <h4 className="sec">Now, in revision {d.current_revision}</h4>
          <blockquote className="drawer-quote" data-testid="repin-after">{pin.after || "(no matching text)"}</blockquote>
        </>
      )}
      <span className="refs-acts">
        {can && <button type="button" className="btn sm pri" data-testid={`repin-move-${pin.ref}`} disabled={locked} onClick={onMove}>Move the pin to revision {d.current_revision}</button>}
        <button type="button" className="btn sm" data-testid="repin-cancel" onClick={onCancel}>{can ? "Cancel" : "Close"}</button>
      </span>
    </div>
  );
}
