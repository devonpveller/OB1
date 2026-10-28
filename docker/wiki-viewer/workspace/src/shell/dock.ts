// The dock: one dockview instance, its layout persisted (toJSON/fromJSON, per viewer in this
// browser's localStorage - a convenience, so it never blocks the page when storage is unavailable).
import type { DockviewApi } from "dockview-react";
import { panel, panels, surface } from "./registry";
import { ownedKey } from "../lib/owner";

// the layout is the user's own: kept under a key of their subject (lib/owner.ts)
export const LAYOUT_KEY = "ws.layout.v1";
export const layoutKey = () => ownedKey(LAYOUT_KEY);
const surfaceId = () => surface()?.id ?? "";

let dock: DockviewApi | null = null;

export function setDock(api: DockviewApi | null) {
  dock = api;
}
export function getDock() {
  return dock;
}

export function saveLayout() {
  if (!dock) return;
  try {
    localStorage.setItem(layoutKey(), JSON.stringify(dock.toJSON()));
  } catch { /* storage unavailable: the layout is simply not kept */ }
}

export function savedLayout(): unknown | null {
  try {
    const raw = localStorage.getItem(layoutKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearLayout() {
  try {
    localStorage.removeItem(layoutKey());
  } catch { /* nothing kept */ }
}

// Open (or focus) a registered panel; side panels open beside the writing surface.
export function openPanel(id: string, params: Record<string, unknown> = {}) {
  const entry = panel(id);
  if (!dock || !entry) return;
  const existing = dock.getPanel(id);
  if (existing) {
    existing.api.updateParameters(params);
    existing.api.setActive();
    return;
  }
  const ref = dock.getPanel(surfaceId());
  const direction = entry.position === "left" ? "left" : entry.position === "below" ? "below" : entry.position === "within" ? "within" : "right";
  dock.addPanel({
    id, component: id, title: entry.title, params,
    ...(ref && id !== surfaceId() ? { position: { referencePanel: surfaceId(), direction } } : {}),
  });
}

export function defaultLayout() {
  if (!dock) return;
  dock.clear();
  const s = surface();
  if (s) dock.addPanel({ id: s.id, component: s.id, title: s.title, params: {} });
  for (const p of panels()) if (p.defaultOpen && p.kind !== "surface") openPanel(p.id);
}

export function restoreLayout(): boolean {
  if (!dock) return false;
  const saved = savedLayout() as { panels?: Record<string, { contentComponent?: string }> } | null;
  if (!saved) return false;
  // a panel whose module is no longer registered is dropped, never a broken layout
  const known = new Set(panels().map((p) => p.id));
  const comps = Object.values(saved.panels ?? {}).map((p) => p.contentComponent ?? "");
  if (comps.some((c) => !known.has(c))) return false;
  try {
    dock.fromJSON(saved as never);
    return true;
  } catch {
    return false;
  }
}
