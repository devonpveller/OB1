// Expansion by registration (D18, 2026-09-29): panels and navigation areas are REGISTERED entries -
// declared and versioned - never a list in the shell. A module calls registerPanel / registerNav when
// it is imported (src/panels/index.ts imports each panel module once); the shell reads the registry,
// so a new area is one new module and touches no existing entry.
import type { ComponentType } from "react";

export interface PanelProps {
  params: Record<string, unknown>;
}

export interface PanelEntry {
  id: string;
  version: number;
  title: string;
  // "surface": the writing surface (the centre). "side": a side panel - it follows the at-rest rule
  // (summary first, leaves on selection, actions only when a leaf is selected; D1).
  kind: "surface" | "side";
  component: ComponentType<PanelProps>;
  // where it opens, relative to the writing surface
  position?: "left" | "right" | "below" | "within";
  // part of the first (default) layout - declared by the entry, never listed by the shell
  defaultOpen?: boolean;
}

export interface NavEntry {
  id: string;
  version: number;
  label: string;
  order: number;
  panel: string; // the panel it opens
}

const panelMap = new Map<string, PanelEntry>();
const navMap = new Map<string, NavEntry>();
const subs = new Set<() => void>();
let version = 0;

function bump() {
  version++;
  subs.forEach((f) => f());
}

export function registerPanel(e: PanelEntry) {
  const cur = panelMap.get(e.id);
  if (cur && cur.version > e.version) return; // a later version is already registered
  panelMap.set(e.id, e);
  bump();
}

export function registerNav(e: NavEntry) {
  const cur = navMap.get(e.id);
  if (cur && cur.version > e.version) return;
  navMap.set(e.id, e);
  bump();
}

export function panels(): PanelEntry[] {
  return [...panelMap.values()];
}

export function panel(id: string): PanelEntry | undefined {
  return panelMap.get(id);
}

// The writing surface: the one registered entry of kind "surface".
export function surface(): PanelEntry | undefined {
  return panels().find((p) => p.kind === "surface");
}

export function navEntries(): NavEntry[] {
  return [...navMap.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function registryVersion() {
  return version;
}

export function onRegistryChange(f: () => void) {
  subs.add(f);
  return () => subs.delete(f);
}
