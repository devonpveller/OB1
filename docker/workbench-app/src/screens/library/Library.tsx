// Screen 10, the Library (rwr-lib-shell): four tabs (Discover / For my document / Saved / Insights), the Recently viewed strip and a
// source or claim opening as its own tab. Only the SHELL is built here. Each tab's content is another item's, so each says plainly that
// it is not built yet and offers nothing to press: it must never look like it works.
//
// The strip is the person's own list kept in the ACCOUNT (state.ts, key library.recent): the last 8 chips plus any locked ones, in any
// browser. A chip holds {kind, id[, locked]} and nothing else; titles live in memory for the person on the page (lib/recent.ts) and are
// never stored, logged or put in the page title. A chip whose item cannot be read (hidden, cut loose, erased, no longer available) shows
// that STATE and not the title. Everything below is keyed by the signed-in subject, so when another person arrives on the page (no reload)
// every dialog, confirmation, result and draft of the previous person is gone with the old tree.
//
// Sends nothing to any model. Its reads: the account, the shared sources' states, the caller's own documents (for the picker); its one
// write besides the account: a cite added to a document's to-place list.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ScreenProps } from "../../routes";
import { Link } from "../../shell/Link";
import { navigate } from "../../lib/router";
import { ItemPicker, type PickerItem } from "../../components/picker";
import {
  getAccountError, getLockedDocument, getRecent, isAccountLoaded, isLoadingState, loadAccountState, recentItemProblem, updateRecentSaved,
  stateEpoch, subscribeState, type RecentItem,
} from "../../lib/state";
import { STRIP_N, closeKeys, closeSet, keyOf, lockIn, openIn, type CloseScope } from "../../lib/recent";
import {
  OUTCOME_WHY, STATE_TEXT, addToPlace, chipLabel, isOpenable, itemUrl, readSourceStates, searchMyDocuments, stateOf, whyNotCitable,
  type AddOutcome, type ChipState,
} from "./library-data";
import "./library.css";

type TabId = "discover" | "fordoc" | "saved" | "insights";
const TABS: { id: TabId; path: string; label: string; phase: number; will: string }[] = [
  { id: "discover", path: "/library", label: "Discover", phase: 2, will: "Browse the shared library: how far out to look, what is new, and what sits next to what you have." },
  { id: "fordoc", path: "/library/for-document", label: "For my document", phase: 2, will: "Sources and claims chosen for the document you have locked." },
  { id: "saved", path: "/library/saved", label: "Saved", phase: 2, will: "Your reading list and favourites." },
  { id: "insights", path: "/library/insights", label: "Insights", phase: 8, will: "What the library has learned across your documents." },
];

type Item = { kind: "source" | "claim"; id: string };
const parseItem = (search: string): Item | "bad" | null => {
  const q = new URLSearchParams(search);
  for (const kind of ["source", "claim"] as const) {
    if (!q.has(kind)) continue;
    const id = q.get(kind) ?? "";
    return recentItemProblem({ kind, id }) === null ? { kind, id } : "bad";
  }
  return null;
};

// ── the states of the strip's sources: ONE request for all of them, again when the list changes or the page regains focus ──
function useSourceStates(ids: string[], enabled: boolean) {
  const key = ids.join(",");
  const [got, setGot] = useState<{ key: string; map: Map<string, ChipState> | null; failed: boolean }>({ key: "", map: null, failed: false });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    window.addEventListener("focus", on);
    return () => window.removeEventListener("focus", on);
  }, []);
  useEffect(() => {
    if (!enabled || ids.length === 0) return;
    let live = true;
    const epoch = stateEpoch();
    readSourceStates(ids).then(
      (map) => { if (live && epoch === stateEpoch()) setGot({ key, map, failed: false }); },
      () => { if (live && epoch === stateEpoch()) setGot((g) => ({ key, map: g.map, failed: true })); }, // the last answer stands
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, tick]);
  // the last answer stands while a changed list is re-checked (a state, never a title); a source it does not hold yet is "checking"
  return got;
}

export function Library(props: ScreenProps) {
  // everything below belongs to ONE person: a different person gets a new tree, with no dialog, result or draft of the last
  return <LibraryFor key={props.subject ?? "(not known yet)"} {...props} />;
}

type Skipped = { label: string; why: string }[];
type Result = { title: string; added: number; already: number; notAdded: Skipped; stopped: string | null };
// the exact chips a confirmation named, frozen when it was asked: "yes" closes these and nothing else
type Confirm = { scope: CloseScope; target: string; keys: string[]; n: number };

function LibraryFor({ route }: ScreenProps) {
  const recent = useSyncExternalStore(subscribeState, getRecent);
  const loaded = useSyncExternalStore(subscribeState, isAccountLoaded);
  const loading = useSyncExternalStore(subscribeState, isLoadingState);
  const accountError = useSyncExternalStore(subscribeState, getAccountError);
  const locked = useSyncExternalStore(subscribeState, getLockedDocument);

  const tab = TABS.find((t) => t.path === route.path) ?? TABS[0];
  const item = parseItem(window.location.search);
  const openItem = item && item !== "bad" ? item : null;

  const sourceIds = useMemo(() => {
    const ids = recent.filter((r) => r.kind === "source").map((r) => r.id);
    if (openItem?.kind === "source" && !ids.includes(openItem.id)) ids.push(openItem.id);
    return ids;
  }, [recent, openItem?.kind, openItem?.id]);
  const checked = useSourceStates(sourceIds, loaded);
  const stateFor = (x: { kind: string; id: string }): ChipState => stateOf(x, checked.map, checked.failed);

  const [note, setNote] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [picking, setPicking] = useState<{ items: Item[]; skipped: Skipped } | null>(null);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [lockNote, setLockNote] = useState<string | null>(null);
  const inflight = useRef(0);
  const head = useRef<HTMLHeadingElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);

  // the account's list is changed only through here: a refusal (another browser wrote first, or the write failed) is said, not hidden
  // `fn` is a CHANGE, applied to the latest list the server holds when the write runs (never to this page's old copy)
  const commit = async (fn: (list: RecentItem[]) => RecentItem[]) => {
    if (inflight.current === 0) setNote(null); // a new burst of changes starts clean; what a change in it says is kept until the next burst
    inflight.current++;
    const r = await updateRecentSaved(fn);
    inflight.current--;
    if (r === "merged") setNote("Your Recently viewed list had been changed in another browser. Your change was applied on top of that.");
    else if (r === "merged-unchanged") setNote("Your Recently viewed list had been changed in another browser. On its list there was nothing left for your change to do, so nothing was written.");
    else if (r === "failed") setNote(getAccountError() ? "That change was not saved. Try again." : "Your Recently viewed list changed in another browser, so it was reloaded. Do that again if you still want it.");
    return r !== "failed";
  };

  // opening an item (its address is the tab): recorded once the list is known, and only for an item this page can vouch for. A source
  // must exist in the shared library (an unknown or held id is "not available" and is not recorded); a claim must have been read here.
  const recorded = useRef<string>("");
  const itemKey = openItem ? keyOf(openItem) : "";
  const itemState = openItem ? stateFor(openItem) : "checking";
  const itemSettled = openItem?.kind === "source" ? (itemState === "active" || itemState === "suppressed" || itemState === "unlinked" || itemState === "erased") : openItem?.kind === "claim" ? itemState === "active" : false;
  useEffect(() => {
    if (!openItem || !loaded || !itemSettled || recorded.current === itemKey) return;
    recorded.current = itemKey;
    const now = getRecent();
    if (now.some((x) => keyOf(x) === itemKey)) return;
    void commit((l) => openIn(l, openItem)).then(() => {
      if (!getRecent().some((x) => keyOf(x) === itemKey)) setNote(`It was not kept in Recently viewed: ${getRecent().length} chips are held and the list is full. Unlock one.`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey, loaded, itemSettled]);

  const lockedCount = recent.filter((r) => r.locked).length;
  const unlockedCount = recent.length - lockedCount;
  const busy = confirm !== null;

  const lockedTitle = locked?.title ?? null;
  const citable = recent.filter((r) => whyNotCitable(r, stateFor(r)) === null);
  const waiting = recent.some((r) => r.kind === "source" && stateFor(r) === "checking");

  // ── add: to the locked document, or to the one the person picks ──
  const startAdd = (items: Item[], skipped: Skipped = []) => {
    setResult(null);
    if (locked) void runAdd(items, skipped, locked.id, locked.title);
    else setPicking({ items, skipped });
  };
  const runAdd = async (items: Item[], skipped: Skipped, path: string, title: string) => {
    if (adding) return;
    const epoch = stateEpoch();
    setAdding(true); setPicking(null);
    const out: Result = { title, added: 0, already: 0, notAdded: [...skipped], stopped: null };
    for (const it of items) {
      if (epoch !== stateEpoch()) return; // another person is on the page: nothing more goes out under them
      const o: AddOutcome = await addToPlace(path, it);
      if (epoch !== stateEpoch()) return; // and this result is not theirs
      if (o === "added") out.added++;
      else if (o === "already") out.already++;
      else if (o === "no-document") { out.stopped = OUTCOME_WHY["no-document"]; break; }
      else out.notAdded.push({ label: chipLabel(it, stateFor(it)), why: OUTCOME_WHY[o] });
    }
    setAdding(false);
    setResult(out);
  };
  const addAll = () => {
    const rows: Item[] = [];
    const skipped: Skipped = [];
    for (const r of recent) {
      const why = whyNotCitable(r, stateFor(r));
      if (why === null && (r.kind === "source" || r.kind === "claim")) rows.push({ kind: r.kind, id: r.id });
      else skipped.push({ label: chipLabel(r, stateFor(r)), why: why ?? "only sources and claims can be cited" });
    }
    startAdd(rows, skipped);
  };

  // ── closes ──
  const ask = (scope: CloseScope, target: string) => {
    setMenu(null);
    const keys = closeSet(recent, scope, scope === "all" ? undefined : target).map(keyOf);
    if (keys.length === 0) return;
    setConfirm({ scope, target, keys, n: keys.length });
    setTimeout(() => cancelBtn.current?.focus(), 0);
  };
  const doClose = async (keys: string[]) => {
    const viewed = openItem ? keyOf(openItem) : "";
    const ok = await commit((l) => closeKeys(l, keys));
    if (ok && viewed && keys.includes(viewed) && !getRecent().some((x) => keyOf(x) === viewed)) navigate("/library");
  };
  const confirmYes = async () => {
    if (!confirm) return;
    const c = confirm;
    setConfirm(null);
    await doClose(c.keys);
    head.current?.focus();
  };

  const toggleLock = (key: string) => {
    setMenu(null);
    const was = recent.find((x) => keyOf(x) === key);
    // the rule is judged on the list the write is made against (the server's latest), not only on this page's copy: the last time the
    // change is applied decides whether it was refused
    let refused: string | undefined;
    setLockNote(null);
    const done = commit((l) => { const r = lockIn(l, key, !was?.locked); refused = r.refused; return r.list; });
    if (refused) setLockNote(refused); // the page's own copy already refuses it
    void done.then(() => setLockNote(refused ?? null)); // and the last time it was applied (to the server's list) decides
  };

  const label = (x: RecentItem) => chipLabel(x, stateFor(x));
  const itemLabel = openItem ? chipLabel(openItem, itemState) : "";
  const addDisabledWhy = citable.length === 0
    ? (waiting ? "Checking the sources in Recently viewed." : "Nothing in Recently viewed can be cited yet. Open a source to put it here.")
    : null;

  return (
    <section className="screen library" data-testid="library">
      <h1>Library</h1>

      <nav aria-label="Library tabs" data-testid="library-tabs">
        <ul className="tabs">
          {TABS.map((t) => (
            <li key={t.id}>
              <Link to={t.path} data-testid={"tab-" + t.id} aria-current={!openItem && item !== "bad" && tab.id === t.id ? "page" : undefined}>{t.label}</Link>
            </li>
          ))}
          {openItem && (
            <li>
              <Link to={itemUrl(openItem.kind, openItem.id)} data-testid="tab-item" aria-current="page" className="tab-item">{itemLabel}</Link>
            </li>
          )}
        </ul>
      </nav>

      {/* ── Recently viewed: on every tab ── */}
      <section className="strip card" aria-labelledby="h-strip" data-testid="strip" data-ready={loaded ? "true" : "false"}>
        <div className="strip-head">
          <h2 id="h-strip" ref={head} tabIndex={-1}>Recently viewed</h2>
          <span className="meta" data-testid="strip-count">{unlockedCount} of {STRIP_N}{lockedCount ? `, ${lockedCount} locked` : ""}</span>
        </div>
        <p className="meta">The last {STRIP_N} things you opened, and any you lock. It follows you to any browser you sign in on.</p>
        {!loaded && !loading && accountError && (
          <p className="err" role="alert" data-testid="strip-error">
            Your Recently viewed list could not be read. Nothing will be written over it.{" "}
            <button type="button" onClick={() => void loadAccountState()} data-testid="strip-retry">Try again</button>
          </p>
        )}
        {!loaded && !accountError && <p className="meta" role="status">Reading your Recently viewed list.</p>}
        {note && <p className="note" role="status" data-testid="strip-note">{note}</p>}
        {lockNote && <p className="note" role="status" data-testid="strip-lock-note">{lockNote}</p>}

        {loaded && recent.length === 0 && <p className="empty" data-testid="strip-empty">Nothing here yet. A source you open is kept here.</p>}
        <ul className="strip-chips">
          {recent.map((r) => {
            const key = keyOf(r);
            const st = stateFor(r);
            const text = label(r);
            const isLocked = r.locked === true;
            const isOpen = menu === key;
            const cannotClose = closeSet(recent, "one", key).length === 0;
            const cnt = (s: CloseScope) => closeSet(recent, s, key).length;
            const act = (s: CloseScope, name: string, nothing: string) => (
              <button type="button" disabled={busy || cnt(s) === 0} title={cnt(s) === 0 ? nothing : undefined} data-testid={"act-close-" + s} onClick={() => ask(s, key)}>{name}</button>
            );
            return (
              <li key={key} className={"rv-chip" + (openItem && keyOf(openItem) === key ? " cur" : "")} data-testid="chip" data-key={key} data-state={st} data-locked={isLocked ? "true" : "false"}>
                {isOpenable(r.kind)
                  ? <Link to={itemUrl(r.kind, r.id)} className="rv-open" data-testid="chip-open">{text}</Link>
                  : <span className="rv-open" data-testid="chip-open">{text}</span>}
                {isLocked && <span className="rv-lock" data-testid="chip-lock">locked</span>}
                <button type="button" className="rv-menu" aria-label={`Actions for ${text}`} aria-expanded={isOpen} disabled={busy} data-testid="chip-menu"
                  onClick={() => setMenu(isOpen ? null : key)}>{"⋯"}</button>
                {isOpen && (
                  <div className="rv-actions" role="group" aria-label={`Actions for ${text}`} data-testid="chip-actions">
                    <button type="button" data-testid="act-lock" disabled={busy} onClick={() => toggleLock(key)}>{isLocked ? "Unlock this chip" : "Lock this chip"}</button>
                    <button type="button" data-testid="act-close" disabled={busy || cannotClose} title={cannotClose ? "Unlock it to close it" : undefined}
                      onClick={() => { setMenu(null); void doClose([key]); }}>Close</button>
                    {cannotClose && <span className="meta">Locked: unlock it to close it.</span>}
                    {act("left", "Close left", "Nothing to close to the left")}
                    {act("right", "Close right", "Nothing to close to the right")}
                    {act("others", "Close others", "Nothing else to close")}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="strip-actions">
          <button type="button" data-testid="add-all" disabled={busy || adding || addDisabledWhy !== null} aria-describedby={addDisabledWhy ? "why-add" : undefined} onClick={addAll}>
            {adding ? "Adding" : lockedTitle ? `Add all to ${lockedTitle}` : "Add all to a document"}
          </button>
          <button type="button" data-testid="save-all" disabled aria-describedby="why-save">Save all</button>
          <button type="button" className="danger-line" data-testid="close-all" disabled={busy || closeSet(recent, "all").length === 0} onClick={() => ask("all", "all")}>Close all</button>
        </div>
        {addDisabledWhy && <p className="meta" id="why-add" data-testid="add-all-why">{addDisabledWhy}</p>}
        <p className="meta" id="why-save" data-testid="save-all-why">Saved is not built yet, so there is nowhere to save these. Save all turns on with it.</p>
        {!lockedTitle && !addDisabledWhy && <p className="meta">No document is locked, so Add all asks which one.</p>}

        {confirm && (
          <div key={confirm.scope + ":" + confirm.target} className="confirm" role="group" aria-label="Confirm closing" data-testid="confirm-close" data-action={confirm.scope} data-target={confirm.target}>
            <p>Close {confirm.n} {confirm.n === 1 ? "chip" : "chips"}? Locked chips stay.</p>
            <div className="confirm-actions">
              <button type="button" className="danger" data-testid="confirm-yes" onClick={() => void confirmYes()}>Close {confirm.n} {confirm.n === 1 ? "chip" : "chips"}</button>
              <button type="button" ref={cancelBtn} data-testid="confirm-no" onClick={() => { setConfirm(null); head.current?.focus(); }}>Cancel</button>
            </div>
          </div>
        )}

        <div role="status" aria-live="polite" data-testid="add-status">
          {result && <ResultView r={result} />}
        </div>

        {picking && (
          <ItemPicker mode="single" title="Which document?" subtitle="The cites go to that document's To place list. Nothing is locked or changed."
            scope={{ kind: "library+mine" }} onlyKinds={["document"]} mineSearch={searchMyDocuments} confirmLabel={() => "Add here"}
            onCancel={() => setPicking(null)}
            onConfirm={(sel: PickerItem[]) => { const d = sel[0]; if (d) void runAdd(picking.items, picking.skipped, d.id, d.title); }} />
        )}
      </section>

      {/* ── the tab ── */}
      {item === "bad" && (
        <div className="card" data-testid="item-bad"><p>That address does not name a source or a claim, so there is nothing to open.</p></div>
      )}
      {openItem && (
        <section className="item card" aria-labelledby="h-item" data-testid="item" data-kind={openItem.kind} data-id={openItem.id}>
          <h2 id="h-item" data-testid="item-title">{itemLabel}</h2>
          <p className="meta" data-testid="item-state">{STATE_TEXT[itemState] ?? (openItem.kind === "source" ? "This source is in the shared library." : "This claim was read in this page.")}</p>
          <p>The reading screen for a {openItem.kind} is coming in phase 2. Until then this tab keeps it in Recently viewed and can add it to a document's To place list.</p>
          <div className="item-actions">
            <button type="button" data-testid="item-add" disabled={adding || whyNotCitable(openItem, itemState) !== null}
              aria-describedby={whyNotCitable(openItem, itemState) ? "why-item" : undefined}
              onClick={() => startAdd([openItem])}>{lockedTitle ? `Add to ${lockedTitle}` : "Add to a document"}</button>
            <button type="button" data-testid="item-close" disabled={busy || recent.find((x) => keyOf(x) === itemKey)?.locked === true}
              onClick={() => { void doClose([itemKey]); navigate("/library"); }}>Close this tab</button>
          </div>
          {whyNotCitable(openItem, itemState) && <p className="meta" id="why-item" data-testid="item-add-why">It cannot be added because {whyNotCitable(openItem, itemState)}.</p>}
        </section>
      )}
      {!openItem && item !== "bad" && (
        <div className="card soon" data-testid="panel-coming" data-tab={tab.id}>
          <p className="soon-line">{tab.label} is not built yet. It is coming in phase {tab.phase}, so nothing here works yet.</p>
          <p>{tab.will}</p>
        </div>
      )}
    </section>
  );
}

function ResultView({ r }: { r: Result }) {
  return (
    <div className="result" data-testid="add-result">
      {r.stopped ? <p>Nothing was added: {r.stopped}.</p> : (
        <p>
          Added {r.added} to {r.title}.{r.already ? ` ${r.already} already waiting.` : ""}{r.notAdded.length ? ` ${r.notAdded.length} not added:` : ""}
        </p>
      )}
      {r.notAdded.length > 0 && !r.stopped && (
        <ul data-testid="add-not-added">{r.notAdded.map((n, i) => <li key={i}>{n.label}: {n.why}</li>)}</ul>
      )}
    </div>
  );
}
