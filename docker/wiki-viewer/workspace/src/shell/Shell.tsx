// The workspace shell: the standard title bar, the fixed left nav and the dock. Both the nav and
// the dock's panels come from the registry (registry.ts) - the shell names none of them.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { navEntries, onRegistryChange, panels, registryVersion } from "./registry";
import { defaultLayout, openPanel, restoreLayout, saveLayout, setDock } from "./dock";
import { TitleBar } from "./TitleBar";
import { post, D } from "../lib/api";

function useRegistry() {
  return useSyncExternalStore(onRegistryChange, registryVersion);
}

export function LeftNav() {
  useRegistry();
  return (
    <nav className="ws-nav" aria-label="workspace areas">
      {navEntries().map((n) => (
        <button key={n.id} type="button" className="ws-nav-entry" data-nav={n.id} onClick={() => openPanel(n.panel)}>
          {n.label}
        </button>
      ))}
    </nav>
  );
}

export function Shell() {
  const v = useRegistry();
  const components = useMemo(() => {
    const map: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {};
    for (const p of panels()) {
      const C = p.component;
      map[p.id] = (props: IDockviewPanelProps) => (
        <div className={`ws-panel ws-panel-${p.kind}`} data-panel={p.id}>
          <C params={(props.params ?? {}) as Record<string, unknown>} />
        </div>
      );
    }
    return map;
    // the registry is read at render; a registration re-renders (v)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);

  // D12 truth and repair: every connect runs the documents reconcile pass (a listing a failed save
  // left stale is repaired here)
  useEffect(() => {
    post(`${D}/reconcile`).catch(() => {});
  }, []);

  const onReady = (e: DockviewReadyEvent) => {
    setDock(e.api);
    if (!restoreLayout()) defaultLayout();
    e.api.onDidLayoutChange(() => saveLayout());
    saveLayout();
  };

  return (
    <div className="ws-root">
      <TitleBar />
      <div className="ws-body">
        <LeftNav />
        <main className="ws-dock">
          <DockviewReact components={components} onReady={onReady} className="dockview-theme-abyss ws-dockview" />
        </main>
      </div>
    </div>
  );
}
