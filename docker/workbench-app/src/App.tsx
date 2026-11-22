import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { applyTheme, readTheme, type ThemeChoice } from "./lib/theme";
import { useRoute } from "./lib/router";
import { getLastDocument, getLockedDocument, loadAccountState, setLockedDocument, stateEpoch, subscribeState } from "./lib/state";
import { loadShellData, useShellData, type Load } from "./lib/shell-data";
import { matchRoute } from "./routes";
import { TopBar } from "./shell/TopBar";
import { Rail } from "./shell/Rail";
import { DefaultSubjectBanner } from "./shell/Banner";
import { SearchOverlay } from "./shell/SearchOverlay";
import { Placeholder, NotFound } from "./shell/Placeholder";
import { Overview } from "./shell/Overview";
import { Home } from "./screens/home/Home";
import { ToastProvider, useToast } from "./shell/Toast";

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };

function Shell({ load }: { load: Load }) {
  const route = useRoute();
  const d = useShellData(load);
  const locked = useSyncExternalStore(subscribeState, getLockedDocument);
  const last = useSyncExternalStore(subscribeState, getLastDocument);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [searching, setSearching] = useState(false);
  const toast = useToast();
  const def = route.bad ? null : matchRoute(route.path);

  // Ctrl+K (or Cmd+K) opens the overlay on every screen; Esc is handled inside the overlay.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); setSearching(true); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  useEffect(() => {
    document.title = (def === "overview" ? "What moved where" : def ? def.label : "Not found") + " - Research workbench";
  }, [def]);

  // The locked / last document and the rest of the per-person state live in the ACCOUNT: read them once the person
  // is known, and again when a different person is on the page (shell-data has just reset the local copy).
  const subject = d.who?.subject ?? null;
  useEffect(() => {
    if (subject !== null) void loadAccountState();
  }, [subject]);

  const unlock = useCallback(() => {
    const was = getLockedDocument();
    if (!was) return;
    const epoch = stateEpoch();
    setLockedDocument(null);
    // Undo restores the document only for the person who unlocked it: after a switch of person it does nothing
    toast({ message: "Unlocked a document.", onUndo: () => { if (stateEpoch() === epoch) setLockedDocument(was); } });
  }, [toast]);

  return (
    <div className="frame">
      {/* the page behind the Ctrl+K dialog is inert while it is open (no focus, clicks or screen reader reach it) */}
      <div className="page" data-testid="page" inert={searching}>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to the screen</a>
      <TopBar who={d.who} locked={locked} onSearch={() => setSearching(true)} onUnlock={unlock} />
      {d.defaultSubject && <DefaultSubjectBanner />}
      <div className="body">
        <Rail path={route.path} d={d} locked={locked} last={last} theme={theme}
          onTheme={() => { const n = NEXT[theme]; applyTheme(n); setTheme(n); }} />
        <main className="main" id="main" tabIndex={-1} data-testid="main">
          {def === "overview" ? <Overview /> : def?.path === "/" ? <Home subject={d.who?.subject ?? null} whoAnswered={d.whoDone === true} /> : def ? <Placeholder def={def} /> : <NotFound path={route.path} />}
        </main>
      </div>
      </div>
      {searching && <SearchOverlay onClose={() => setSearching(false)} />}
    </div>
  );
}

// `load` is the shell's one read of "who am I and the menu counts"; a test passes its own.
export function App({ load = loadShellData }: { load?: Load }) {
  return <ToastProvider><Shell load={load} /></ToastProvider>;
}
