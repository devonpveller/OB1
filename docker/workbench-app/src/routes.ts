// The route table: what the left menu lists and what each path opens. A screen that is not built yet
// carries the phase of the build plan that delivers it, and says so (Placeholder). Later items replace
// a placeholder by giving its entry a `screen`; the menu does not change.
export type Group = "everywhere" | "housekeeping";
export type RouteDef = {
  path: string;
  label: string;
  group?: Group;
  phase: number;
  will: string; // one plain sentence: what the screen will do
  inMenu: boolean;
};

export const ROUTES: RouteDef[] = [
  { path: "/", label: "Home", group: "everywhere", phase: 0, will: "Ask the library, pick up where you left off, and see what is running.", inMenu: true },
  { path: "/research", label: "Research", group: "everywhere", phase: 3, will: "Every research run as a tree of questions and branches.", inMenu: true },
  { path: "/chat", label: "Chat", group: "everywhere", phase: 4, will: "Chat about everything, a document, an idea or a research run.", inMenu: true },
  { path: "/documents", label: "Documents", group: "everywhere", phase: 1, will: "Your documents in folders: open, archive, restore.", inMenu: true },
  { path: "/ideas", label: "Ideas", group: "everywhere", phase: 4, will: "Capture an idea and refine it with its sources.", inMenu: true },
  { path: "/podcasts", label: "Podcasts", group: "everywhere", phase: 3, will: "Your episodes and the live discussions.", inMenu: true },
  { path: "/library", label: "Library", group: "everywhere", phase: 2, will: "Sources and claims: browse, check quality, add to a document.", inMenu: true },
  { path: "/imports", label: "Imports", group: "housekeeping", phase: 5, will: "Bring links and files in, and see what happened to each.", inMenu: true },
  { path: "/removals", label: "Removals and trail", group: "housekeeping", phase: 5, will: "What was removed, when, and why.", inMenu: true },
  { path: "/cleanup", label: "Cleanup", group: "housekeeping", phase: 5, will: "Sources waiting to be cleaned up.", inMenu: true },
  { path: "/settings", label: "Settings", group: "housekeeping", phase: 6, will: "Your account, privacy and preferences.", inMenu: true },
  // not in the menu
  { path: "/documents/:id", label: "Document", phase: 1, will: "The writing surface, with its references, topics and history.", inMenu: false },
  { path: "/research/start", label: "Start research", phase: 3, will: "Ask a question and choose how deep the run goes.", inMenu: false },
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
