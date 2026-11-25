// The route table: what the left menu lists and what each path opens. A screen that is not built yet
// carries the phase of the build plan that delivers it, and says so (Placeholder). A built screen is its
// entry's `screen` (rwr-docs-list): App.tsx renders `screen` when there is one, else the Placeholder, so a
// later item adds its screen with ONE change here (`screen: X` on its entry, plus the import); the menu,
// App.tsx and the other entries do not change.
import type { ComponentType } from "react";
import type { Route } from "./lib/router";
import { Home } from "./screens/home/Home";
import { Documents } from "./screens/documents/Documents";
import { DocumentScreen, LegacyDocument } from "./screens/documents/DocumentScreen";
import { Imports } from "./screens/imports/Imports";
import { StartResearch } from "./screens/research-start/StartResearch";

export type Group = "everywhere" | "housekeeping";
// What every screen is given. `params` holds the route's `:name` segments, decoded (so /documents/d/:ref with
// /documents/d/e0000000-... gives ref = "e0000000-..."; the old /documents/:id form carries a path). `subject` is the signed-in person once the
// shell knows it (null until then); `whoAnswered` is true once whoami has answered, with a person or without.
export type ScreenProps = { route: Route; params: Record<string, string>; subject: string | null; whoAnswered: boolean };
export type RouteDef = {
  path: string;
  label: string;
  group?: Group;
  phase: number;
  will: string; // one plain sentence: what the screen will do
  inMenu: boolean;
  screen?: ComponentType<ScreenProps>; // the built screen; absent = the "coming in phase N" placeholder
};

export const ROUTES: RouteDef[] = [
  { path: "/", label: "Home", group: "everywhere", phase: 0, will: "Ask the library, pick up where you left off, and see what is running.", inMenu: true, screen: Home },
  { path: "/research", label: "Research", group: "everywhere", phase: 3, will: "Every research run as a tree of questions and branches.", inMenu: true },
  { path: "/chat", label: "Chat", group: "everywhere", phase: 4, will: "Chat about everything, a document, an idea or a research run.", inMenu: true },
  { path: "/documents", label: "Documents", group: "everywhere", phase: 1, will: "Your documents in folders: open, archive, restore.", inMenu: true, screen: Documents },
  { path: "/ideas", label: "Ideas", group: "everywhere", phase: 4, will: "Capture an idea and refine it with its sources.", inMenu: true },
  { path: "/podcasts", label: "Podcasts", group: "everywhere", phase: 3, will: "Your episodes and the live discussions.", inMenu: true },
  { path: "/library", label: "Library", group: "everywhere", phase: 2, will: "Sources and claims: browse, check quality, add to a document.", inMenu: true },
  { path: "/imports", label: "Imports", group: "housekeeping", phase: 5, will: "Bring links and files in, and see what happened to each.", inMenu: true, screen: Imports },
  { path: "/removals", label: "Removals and trail", group: "housekeeping", phase: 5, will: "What was removed, when, and why.", inMenu: true },
  { path: "/cleanup", label: "Cleanup", group: "housekeeping", phase: 5, will: "Sources waiting to be cleaned up.", inMenu: true },
  { path: "/settings", label: "Settings", group: "housekeeping", phase: 6, will: "Your account, privacy and preferences.", inMenu: true },
  // not in the menu
  { path: "/documents/d/:ref", label: "Document", phase: 1, will: "The writing surface, with its references, topics and history.", inMenu: false, screen: DocumentScreen },
  // an old /documents/<path> address: resolved to the id form and replaced (no path left in history)
  { path: "/documents/:id", label: "Document", phase: 1, will: "The writing surface, with its references, topics and history.", inMenu: false, screen: LegacyDocument },
  { path: "/research/start", label: "Start research", phase: 3, will: "Ask a question and choose how deep the run goes.", inMenu: false, screen: StartResearch },
];
export const OVERVIEW_PATH = "/what-moved-where";

export function matchRoute(path: string): RouteDef | "overview" | null {
  if (path === OVERVIEW_PATH) return "overview";
  const seg = path.split("/").filter(Boolean);
  for (const r of ROUTES) {
    const rs = r.path.split("/").filter(Boolean);
    if (rs.length === seg.length && rs.every((s, i) => s.startsWith(":") || s === seg[i])) return r;
  }
  return null;
}

// The `:name` segments of a matched route, decoded (the router decodes each segment once, after the split).
export function routeParams(def: RouteDef, route: Route): Record<string, string> {
  const out: Record<string, string> = {};
  def.path.split("/").filter(Boolean).forEach((s, i) => { if (s.startsWith(":")) out[s.slice(1)] = route.segments[i] ?? ""; });
  return out;
}

// Which menu entry is current: the entry whose path is the route, or a parent of it.
export function activeMenuPath(path: string): string | null {
  if (path === OVERVIEW_PATH) return OVERVIEW_PATH;
  let best: string | null = null;
  for (const r of ROUTES) {
    if (!r.inMenu) continue;
    const on = r.path === "/" ? path === "/" : path === r.path || path.startsWith(r.path + "/");
    if (on && (best === null || r.path.length > best.length)) best = r.path;
  }
  return best;
}
